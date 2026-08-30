const EventEmitter = require('node:events');
const http = require('node:http');
const https = require('node:https');
const { normalizeBoolean, errorMessage, asError, markShutdown } = require('./configUtils');

/**
 * @typedef {import('./configUtils').AdapterError} AdapterError
 * @typedef {import('./configUtils').DssResponse} DssResponse
 */

const RETRYABLE_ERROR_CODES = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED'];

const DEFAULT_REQUEST_TIMEOUT = 30 * 1000;
const SESSION_MAX_AGE = 45 * 1000; // DSS invalidates sessions after 60s idle, renew a bit earlier
const DEFAULT_API_MAX_SOCKETS = 8;
// Must be large enough for all parallel event long-polls (currently 9) plus reserve
const DEFAULT_EVENT_MAX_SOCKETS = 16;
const MAX_EVENT_ERRORS = 5;
const EVENT_RETRY_BASE_DELAY = 2000;
const EVENT_RETRY_MAX_DELAY = 60000;

/**
 * Error of the DSS client.
 *
 * Besides the message it carries structured markers that the consumers evaluate instead
 * of parsing the message text - see the AdapterError typedef in configUtils.
 */
class DSSError extends Error {
    /**
     * @param {string} message
     * @param {number} [status] HTTP status code, if the DSS answered at all
     * @param {ErrorOptions} [options] standard error options, e.g. { cause }
     */
    constructor(message, status, options) {
        super(message, options);
        this.name = 'DSSError';
        /** @type {number|undefined} HTTP status code of the answer */
        this.status = status;
        /** @type {number|undefined} backward compatible field name for status */
        this.status_code = status;
        /** @type {string|undefined} node style error code, e.g. ETIMEDOUT */
        this.code = undefined;
        /** @type {boolean|undefined} true for a request timeout of this client */
        this.timeout = undefined;
        /** @type {boolean|undefined} true when the request was cancelled by stop() */
        this.shutdown = undefined;
    }
}

class DSS extends EventEmitter {
    constructor(options) {
        super();

        this.options = options || {
            logger: console,
        };
        this.host = this.options.host;
        this.appToken = this.options.appToken;
        this.subScriptionId = this.options.subScriptionId || 42;
        this.subScriptionTimeout = this.options.subScriptionTimeout || 40 * 1000;
        this.requestTimeout = this.options.requestTimeout || DEFAULT_REQUEST_TIMEOUT;

        this.baseUrl = DSS.buildBaseUrl(this.host);
        // The DSS uses https, but the configured scheme is respected (also keeps tests transport agnostic)
        this.isSecure = this.baseUrl.startsWith('https:');
        this.transport = this.isSecure ? https : http;

        const agentOptions = {
            // No keep-alive on purpose: the DSS closes idle connections, and a pooled socket
            // that was closed in the meantime results in "socket hang up" on the next request.
            // The request rate is limited by the queue anyway, so pooling would gain very little.
            keepAlive: false,
            // The DSS uses a self-signed certificate, so validation must be opt-in.
            // Normalized here as well because the token dialog builds a client directly
            // from the raw configuration.
            rejectUnauthorized: normalizeBoolean(this.options.validateCertificate, false),
        };
        // Event long-polls occupy their socket for the whole polling timeout. They get their
        // own agent so that normal API calls (scene calls, login, ...) are never queued behind them.
        this.apiAgent = new this.transport.Agent({
            ...agentOptions,
            maxSockets: this.options.apiMaxSockets || DEFAULT_API_MAX_SOCKETS,
        });
        this.eventAgent = new this.transport.Agent({
            ...agentOptions,
            maxSockets: this.options.eventMaxSockets || DEFAULT_EVENT_MAX_SOCKETS,
        });

        this.sessionToken = null;
        this.sessionLastUsed = 0;
        this.sessionLoginPromise = null;

        this.subscriptions = {};
        this.activeRequests = new Set();
        this.stopped = false;
    }

    /**
     * Normalizes a configured host into a base url.
     * Accepts "1.2.3.4", "1.2.3.4:8080", "https://host:8080", "[::1]:8080" and DNS names.
     *
     * @param {string} host configured host value
     * @returns {string} normalized base url without trailing slash
     */
    static buildBaseUrl(host) {
        if (typeof host !== 'string' || !host.trim()) {
            throw new DSSError('No DSS host configured');
        }
        let raw = host.trim();
        const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
        if (schemeMatch) {
            const scheme = schemeMatch[1].toLowerCase();
            if (scheme !== 'https' && scheme !== 'http') {
                throw new DSSError(`Invalid DSS host "${host}": only https and http are supported`);
            }
        } else {
            raw = `https://${raw}`;
        }
        // Split into scheme, authority and everything behind it. Only the authority decides
        // about brackets and the port - a trailing slash must not influence that.
        const schemeEnd = raw.indexOf('://') + 3;
        const scheme = raw.slice(0, schemeEnd);
        const rest = raw.slice(schemeEnd);
        const authorityEnd = rest.search(/[/?#]/);
        let authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
        const trailer = authorityEnd === -1 ? '' : rest.slice(authorityEnd);
        // Bare IPv6 addresses need brackets to be parseable ("::1" -> "[::1]")
        if (!authority.startsWith('[') && (authority.match(/:/g) || []).length > 1) {
            authority = `[${authority}]`;
        }
        raw = scheme + authority + trailer;

        let url;
        try {
            url = new URL(raw);
        } catch {
            throw new DSSError(`Invalid DSS host "${host}"`);
        }
        if (url.username || url.password) {
            throw new DSSError('The DSS host must not contain credentials');
        }
        if (url.search || url.hash || (url.pathname && url.pathname !== '/')) {
            throw new DSSError(`Invalid DSS host "${host}": only host and port are allowed`);
        }
        if (!url.hostname) {
            throw new DSSError(`Invalid DSS host "${host}"`);
        }
        // The URL API drops a port that is the default of the scheme (443/80), so the
        // raw authority decides whether the DSS default port 8080 has to be added.
        const hasExplicitPort = authority.includes(']') ? /]:\d+$/.test(authority) : /:\d+$/.test(authority);
        let port = url.port;
        if (!port) {
            port = hasExplicitPort ? (url.protocol === 'https:' ? '443' : '80') : '8080';
        }
        return `${url.protocol}//${url.hostname}:${port}`;
    }

    stop() {
        this.stopped = true;
        Object.keys(this.subscriptions).forEach(eventName => this.clearEventRetry(eventName));
        // Abort in-flight requests (especially the long running event polls)
        this.activeRequests.forEach(req => req.destroy());
        this.activeRequests.clear();
        this.apiAgent.destroy();
        this.eventAgent.destroy();
    }

    /**
     * Low level HTTPS GET against the DSS JSON API
     *
     * @param {string} path e.g. /json/system/login
     * @param {object} [query] query parameters
     * @param {number} [timeout] timeout in ms for this request
     * @param {boolean} [isEventPoll] use the separate event agent for long-polls
     * @returns {Promise<DssResponse>} parsed JSON body
     */
    httpRequest(path, query, timeout, isEventPoll) {
        return new Promise((resolve, reject) => {
            if (this.stopped) {
                // Hard barrier: after stop() the agents are destroyed and no new socket
                // may be opened, no matter which late callback ends up here.
                const stoppedErr = new DSSError(`Client is stopped, not requesting ${path}`);
                stoppedErr.shutdown = true;
                return void reject(stoppedErr);
            }
            const search = query ? `?${new URLSearchParams(query).toString()}` : '';
            const url = this.baseUrl + path + search;
            const effectiveTimeout = timeout || this.requestTimeout;
            let req;
            const done = (err, body) => {
                if (req) {
                    this.activeRequests.delete(req);
                }
                if (err) {
                    reject(err);
                } else {
                    resolve(body);
                }
            };
            req = this.transport.get(
                url,
                {
                    agent: isEventPoll ? this.eventAgent : this.apiAgent,
                    timeout: effectiveTimeout,
                },
                res => {
                    let data = '';
                    res.setEncoding('utf8');
                    res.on('data', chunk => (data += chunk));
                    res.on('end', () => {
                        if (res.statusCode !== 200) {
                            return done(new DSSError(`HTTP ${res.statusCode} for ${path}`, res.statusCode));
                        }
                        try {
                            done(null, JSON.parse(data));
                        } catch (err) {
                            done(
                                new DSSError(`Invalid JSON response for ${path}: ${errorMessage(err)}`, undefined, {
                                    cause: err,
                                }),
                            );
                        }
                    });
                    res.on('error', err =>
                        done(new DSSError(`Response error for ${path}: ${err.message}`, undefined, { cause: err })),
                    );
                },
            );
            this.activeRequests.add(req);
            req.on('timeout', () => {
                // destroy() triggers the 'error' handler with our timeout error.
                // The error carries the structured markers of a real socket timeout so that
                // isRetryableConnectionError() does not have to parse the message text.
                const timeoutError = new DSSError(`Timeout after ${effectiveTimeout}ms for ${path}`);
                timeoutError.code = 'ETIMEDOUT';
                timeoutError.timeout = true;
                req.destroy(timeoutError);
            });
            req.on('error', err =>
                done(
                    err instanceof DSSError
                        ? err
                        : new DSSError(`Request error for ${path}: ${err.message}`, undefined, { cause: err }),
                ),
            );
        });
    }

    /**
     * Returns a valid session token, renews it via loginApplication when needed.
     * Parallel callers share one login request.
     *
     * @returns {Promise<string>}
     */
    async getSessionToken() {
        if (this.sessionToken && Date.now() - this.sessionLastUsed < SESSION_MAX_AGE) {
            return this.sessionToken;
        }
        if (!this.sessionLoginPromise) {
            this.sessionLoginPromise = this.httpRequest('/json/system/loginApplication', {
                loginToken: this.appToken,
            }).then(
                body => {
                    this.sessionLoginPromise = null;
                    if (!body || body.ok !== true || !body.result || !body.result.token) {
                        throw new DSSError(`Login failed: ${(body && body.message) || 'unknown error'}`);
                    }
                    this.sessionToken = body.result.token;
                    this.sessionLastUsed = Date.now();
                    return this.sessionToken;
                },
                err => {
                    this.sessionLoginPromise = null;
                    throw err;
                },
            );
        }
        return this.sessionLoginPromise;
    }

    invalidateSession() {
        this.sessionToken = null;
        this.sessionLastUsed = 0;
    }

    /**
     * True for connection level errors where the request was never answered.
     * Typical case: the DSS closed a pooled keep-alive socket while it was idle
     * and Node picked exactly that socket for the next request ("socket hang up").
     *
     * @param {unknown} err thrown value
     * @returns {boolean}
     */
    static isRetryableConnectionError(err) {
        const error = asError(err);
        if (!error) {
            return false;
        }
        const cause = asError(error.cause);
        // Structured marker of our own request timeout, see httpRequest()
        if (error.timeout === true || (cause && cause.timeout === true)) {
            return true;
        }
        const code = error.code || (cause && cause.code);
        if (code && RETRYABLE_ERROR_CODES.includes(code)) {
            return true;
        }
        return /socket hang up|ECONNRESET|EPIPE/i.test(error.message || '');
    }

    /**
     * Decides whether a request may be sent a second time after a connection error.
     *
     * A connection error does not tell whether the DSS already processed the request -
     * only the answer is known to be missing. Repeating is therefore only allowed for
     * pure reads, where a second execution has no effect at all.
     *
     * Explicitly NOT retryable:
     * - callScene / undoScene: would run the scene twice and can trigger dS automations
     * - event/raise: would raise the event twice
     * - state/set, pushSensorValue, setValue, setConfig: change data other systems react on
     * - event/get: a read, but it consumes the pending events - a repeat would lose them
     *
     * @param {string} dssClass
     * @param {string} dssFunction
     * @returns {boolean} true if a single automatic retry is safe
     */
    static isRetryableRequest(dssClass, dssFunction) {
        return DSS.RETRYABLE_REQUESTS.has(`${dssClass}/${dssFunction}`);
    }

    /**
     * @typedef {object} RequestOptions
     * @property {number} [timeout] timeout override in ms
     * @property {boolean} [eventPoll] use the separate event agent for long-polls
     * @property {boolean} [retryOnConnectionError] overrides the endpoint based default
     */

    /**
     * Do Request to DSS. Resolves only with an "ok" response, rejects otherwise.
     *
     * @param {string} dssClass
     * @param {string} dssFunction
     * @param {object} [params]
     * @param {RequestOptions|number} [options] options object, or a timeout in ms for the legacy signature
     * @param {boolean} [legacyIsEventPoll] only used together with the legacy signature
     * @returns {Promise<DssResponse>} Promise resolving with the JSON body (body.ok === true)
     */
    async requestAsync(dssClass, dssFunction, params, options, legacyIsEventPoll) {
        if (this.stopped) {
            // A callback that was already running when stop() was called must not be able to
            // open a new connection afterwards. Rejecting with the shutdown marker keeps the
            // consumers on their expected-error path instead of producing warnings.
            const err = new DSSError(`Client is stopped, not sending ${dssClass}/${dssFunction}`);
            err.shutdown = true;
            throw err;
        }
        if (!this.appToken) {
            throw new DSSError('You need to provide an appToken or do a login');
        }
        if (typeof options !== 'object' || options === null) {
            // Legacy signature (dssClass, dssFunction, params, timeout, isEventPoll)
            options = { timeout: options, eventPoll: legacyIsEventPoll };
        }
        const timeout = options.timeout;
        const isEventPoll = !!options.eventPoll;
        const mayRetry =
            options.retryOnConnectionError === undefined
                ? DSS.isRetryableRequest(dssClass, dssFunction)
                : !!options.retryOnConnectionError;

        const path = `/json/${dssClass}/${dssFunction}`;
        let retriedAuth = false;
        let retriedConnection = false;
        for (;;) {
            const token = await this.getSessionToken();
            let body;
            try {
                body = await this.httpRequest(path, { ...params, token }, timeout, isEventPoll);
            } catch (err) {
                // Only repeated when a second execution is known to be without effect
                if (mayRetry && !retriedConnection && !this.stopped && DSS.isRetryableConnectionError(err)) {
                    retriedConnection = true;
                    this.options.logger &&
                        this.options.logger.debug(`Connection lost for ${path}, retrying once: ${errorMessage(err)}`);
                    continue;
                }
                if (this.stopped) {
                    // stop() aborts the running requests on purpose - consumers use this flag
                    // to not report the expected shutdown errors as warnings.
                    markShutdown(err);
                }
                throw err;
            }
            this.sessionLastUsed = Date.now();
            if (body && body.ok === true) {
                return body;
            }
            const message = (body && body.message) || 'unknown error';
            // Session might have been invalidated server side (e.g. DSS restart) - retry once with a fresh login
            if (!retriedAuth && /not logged in|authentication|login/i.test(message)) {
                retriedAuth = true;
                this.invalidateSession();
                continue;
            }
            throw new DSSError(`Error response for ${path}: ${message}`);
        }
    }

    async createAppTokenAsync(username, password, readableName) {
        readableName = readableName || 'ioBroker';
        if (typeof username !== 'string' || !username) {
            throw new DSSError('No username provided');
        }
        if (typeof password !== 'string' || !password) {
            throw new DSSError('No password provided');
        }
        const tokenRes = await this.httpRequest('/json/system/requestApplicationToken', {
            applicationName: readableName,
        });
        if (!tokenRes || tokenRes.ok !== true || !tokenRes.result || !tokenRes.result.applicationToken) {
            throw new DSSError(
                `Could not request application token: ${(tokenRes && tokenRes.message) || 'unknown error'}`,
            );
        }
        const appToken = tokenRes.result.applicationToken;

        const loginRes = await this.httpRequest('/json/system/login', { user: username, password });
        if (!loginRes || loginRes.ok !== true || !loginRes.result || !loginRes.result.token) {
            throw new DSSError(
                `Login failed - please check username and password: ${
                    (loginRes && loginRes.message) || 'unknown error'
                }`,
            );
        }

        const enableRes = await this.httpRequest('/json/system/enableToken', {
            applicationToken: appToken,
            token: loginRes.result.token,
        });
        if (!enableRes || enableRes.ok !== true) {
            throw new DSSError(
                `Could not enable application token: ${(enableRes && enableRes.message) || 'unknown error'}`,
            );
        }

        this.appToken = appToken;
        return appToken;
    }

    /**
     * Normalizes a single event from the DSS so that consumers can rely on
     * source/properties being objects. Returns null for unusable entries.
     *
     * @param {object} event raw event as delivered by the DSS
     * @returns {object|null} normalized event
     */
    static normalizeEvent(event) {
        if (!event || typeof event !== 'object' || typeof event.name !== 'string' || !event.name) {
            return null;
        }
        const source = event.source && typeof event.source === 'object' ? event.source : {};
        const properties = event.properties && typeof event.properties === 'object' ? event.properties : {};
        // TempFix: dSID ist eigentlich eine dSUID
        if (source.dsid !== undefined && source.dSUID === undefined) {
            source.dSUID = source.dsid;
        }
        // TempFix: Schreibfehler
        if (properties.sceneId !== undefined && properties.sceneID === undefined) {
            properties.sceneID = properties.sceneId;
        }
        return { ...event, source, properties };
    }

    clearEventRetry(eventName) {
        const sub = this.subscriptions[eventName];
        if (sub && sub.retryTimer) {
            clearTimeout(sub.retryTimer);
            sub.retryTimer = null;
        }
    }

    /**
     * Schedules exactly one retry timer per event using a bounded exponential backoff.
     *
     * @param {string} eventName
     * @param {() => void} action
     */
    scheduleEventRetry(eventName, action) {
        const sub = this.subscriptions[eventName];
        if (!sub || this.stopped) {
            return;
        }
        this.clearEventRetry(eventName);
        const delay = Math.min(EVENT_RETRY_BASE_DELAY * 2 ** Math.max(0, sub.errorCount - 1), EVENT_RETRY_MAX_DELAY);
        sub.retryTimer = setTimeout(() => {
            const current = this.subscriptions[eventName];
            if (current) {
                current.retryTimer = null;
            }
            if (!current || this.stopped) {
                return;
            }
            action();
        }, delay);
    }

    /**
     * Handles a polling or re-subscribe failure for one event: counts the error,
     * emits eventError once the limit is reached, otherwise schedules a retry.
     *
     * @param {string} eventName
     * @param {AdapterError} err
     * @param {string} context short description used for logging
     */
    handleEventFailure(eventName, err, context) {
        const sub = this.subscriptions[eventName];
        if (!sub || this.stopped) {
            return;
        }
        sub.errorCount = (sub.errorCount || 0) + 1;
        const message = errorMessage(err);
        this.options.logger &&
            this.options.logger.warn(`Error on ${context} for event ${eventName} (${sub.errorCount}): ${message}`);

        if (sub.errorCount > MAX_EVENT_ERRORS) {
            this.clearEventRetry(eventName);
            return void this.emit(
                'eventError',
                eventName,
                sub.errorCount,
                `Too many errors on ${context} for ${eventName}: ${message}`,
            );
        }
        // A lost subscription (e.g. after a DSS restart) needs a re-subscribe before polling makes sense again
        const needsResubscribe = sub.errorCount >= 2 || err.status === 500;
        this.scheduleEventRetry(eventName, () => {
            if (needsResubscribe) {
                this.subscribeEvent(eventName, sub.subscriptionId, sub.timeout, subErr => {
                    if (subErr) {
                        this.handleEventFailure(eventName, subErr, 're-subscribing');
                    } else {
                        this.options.logger && this.options.logger.info(`Successfully resubscribed to ${eventName}`);
                    }
                });
            } else {
                this.pollEvent(eventName);
            }
        });
    }

    pollEvent(eventName) {
        const sub = this.subscriptions[eventName];
        if (!sub || this.stopped || sub.polling) {
            return;
        }
        sub.polling = true;
        sub.lastPollTime = Date.now();
        // HTTP timeout needs to be longer than the long-polling timeout of the DSS
        this.requestAsync(
            'event',
            'get',
            { subscriptionID: sub.subscriptionId, timeout: sub.timeout },
            // No retry: event/get consumes the pending events on the DSS, repeating it
            // after a lost answer would drop them. Failures go through the backoff below.
            { timeout: sub.timeout + 15000, eventPoll: true, retryOnConnectionError: false },
        ).then(
            events => {
                const current = this.subscriptions[eventName];
                if (current) {
                    current.polling = false;
                }
                if (!current || this.stopped) {
                    return;
                }
                current.errorCount = 0;
                const rawEvents = (events && events.result && events.result.events) || [];
                if (Array.isArray(rawEvents)) {
                    rawEvents.forEach(rawEvent => {
                        // One broken event must not prevent the remaining events of this response
                        try {
                            const event = DSS.normalizeEvent(rawEvent);
                            if (!event) {
                                this.options.logger &&
                                    this.options.logger.debug(
                                        `Ignoring unusable event on ${eventName}: ${JSON.stringify(rawEvent)}`,
                                    );
                                return;
                            }
                            if (this.subscriptions[eventName]) {
                                this.emit(event.name, event);
                            }
                        } catch (err) {
                            this.options.logger &&
                                this.options.logger.warn(
                                    `Error while handling event on ${eventName}: ${errorMessage(err)}`,
                                );
                        }
                    });
                }
                setImmediate(() => this.pollEvent(eventName));
            },
            err => {
                const current = this.subscriptions[eventName];
                if (current) {
                    current.polling = false;
                }
                this.handleEventFailure(eventName, err, 'polling');
            },
        );
    }

    subscribeEvent(eventName, subscriptionId, timeout, callback) {
        this.requestAsync('event', 'subscribe', { subscriptionID: subscriptionId, name: eventName }).then(
            () => {
                if (this.stopped) {
                    return void (callback && callback(null));
                }
                if (!this.subscriptions[eventName]) {
                    this.subscriptions[eventName] = { subscriptionId, timeout, errorCount: 0, retryTimer: null };
                } else {
                    this.subscriptions[eventName].subscriptionId = subscriptionId;
                    this.subscriptions[eventName].timeout = timeout;
                    // errorCount is deliberately NOT reset here. A successful event/subscribe
                    // says nothing about event/get: if subscribing works but polling keeps
                    // failing (e.g. HTTP 500 on every event/get), resetting here would keep the
                    // counter below the limit forever - the adapter would stay green while
                    // re-subscribing every few seconds and never processing an event again.
                    // Only a successful event/get clears the counter, see pollEvent().
                }
                this.pollEvent(eventName);
                callback && callback(null);
            },
            err => {
                callback && callback(err);
            },
        );
    }

    subscribeEvents(eventNames, startSubscriptionId, timeout, callback) {
        if (typeof startSubscriptionId === 'function') {
            callback = startSubscriptionId;
            timeout = undefined;
            startSubscriptionId = undefined;
        }
        if (typeof timeout === 'function') {
            callback = timeout;
            timeout = undefined;
        }
        timeout = timeout || this.subScriptionTimeout;
        startSubscriptionId = startSubscriptionId || this.subScriptionId;
        if (!Array.isArray(eventNames)) {
            eventNames = [eventNames];
        }
        if (!eventNames.length) {
            return void (callback && setImmediate(() => callback(null)));
        }
        let toSubscribe = eventNames.length;
        const errs = [];
        eventNames.forEach(eventName =>
            this.subscribeEvent(eventName, startSubscriptionId++, timeout, err => {
                if (err) {
                    errs.push(err);
                }
                if (!--toSubscribe) {
                    callback && callback(errs.length ? errs : null);
                }
            }),
        );
    }

    unsubscribeEvent(eventName, callback) {
        const sub = this.subscriptions[eventName];
        if (!sub) {
            return void (callback && callback(null));
        }
        this.clearEventRetry(eventName);
        delete this.subscriptions[eventName];
        this.requestAsync('event', 'unsubscribe', { subscriptionID: sub.subscriptionId, name: eventName }).then(
            () => {
                callback && callback(null);
            },
            err => {
                callback && callback(err);
            },
        );
    }

    unsubscribeAllEvents(callback) {
        let lastPollEnd = 0;
        const subscribedEvents = Object.keys(this.subscriptions);
        let openSubscriptions = subscribedEvents.length;
        if (!openSubscriptions) {
            this.subscriptions = {};
            return void (callback && callback(0));
        }

        subscribedEvents.forEach(eventName => {
            const sub = this.subscriptions[eventName];
            const pollEnd = (sub.lastPollTime || 0) + sub.timeout;
            if (pollEnd > lastPollEnd) {
                lastPollEnd = pollEnd;
            }
            this.unsubscribeEvent(eventName, () => {
                if (!--openSubscriptions) {
                    this.subscriptions = {};
                    callback && callback(lastPollEnd);
                }
            });
        });
    }
}

/**
 * Allowlist of DSS endpoints that may be repeated once after a connection error.
 *
 * Deliberately a positive list: a newly used endpoint is not retried until its
 * semantics have been checked. Every entry is a pure read whose repetition cannot
 * change anything on the DSS or trigger an automation.
 */
DSS.RETRYABLE_REQUESTS = new Set([
    'apartment/getCircuits',
    'apartment/getName',
    // Pure read of the reachable groups of a zone, used once during startup.
    // Repeating it changes nothing on the DSS (same semantics as zone/getReachableScenes).
    'apartment/getReachableGroups',
    'apartment/getSensorValues',
    'apartment/getStructure',
    'apartment/getTemperatureControlStatus',
    // Pure read of the configured set points of one zone
    'zone/getTemperatureControlValues',
    'circuit/getConsumption',
    'circuit/getEnergyMeterValue',
    'device/getConfig',
    'device/getConfigWord',
    'device/getOutputChannelValue',
    'device/getOutputValue',
    'device/getSwitchThreshold',
    // A subscription is a registration, not an action: subscribing the same id and name
    // twice has no effect, so a lost answer during startup may be retried.
    'event/subscribe',
    'property/query',
    'system/version',
    'zone/getLastCalledScene',
    'zone/getReachableScenes',
]);

module.exports = DSS;
module.exports.DSSError = DSSError;
