'use strict';

/*
 * Digitalstrom ioBroker Adapter
 */

/*
Rule 5 When applications send a scene command to a set of digitalSTROM-Devices with more than one target device they have to use scene calls directed to a group, splitting into multiple calls to single devices has to be avoided due to latency and statemachine consistency issues.

Rule 8 Application processes that do automatic cyclic reads or writes of device parameters are subject to a request limit: at maximum one request per minute and circuit is allowed.

Rule 9 Application processes that do automatic cyclic reads of measured values are subject to a request limit: at maximum one request per minute and circuit is allowed.

Rule 10 The action command ”Set Output Value” must not be used for other than device configuration purposes.

Rule 13 Applications that automatically generate Call Scene action commands (see 6.1.1) must not execute the action commands at a rate faster than one request per second.
 */

const utils = require('@iobroker/adapter-core');
const ObjectHelper = require('@apollon/iobroker-tools'); // Get common adapter utils

const DSS = require('./lib/dss');
const DSSQueue = require('./lib/dssQueue');
const DSSStructure = require('./lib/dssStructure');
const DSSSmartHome = require('./lib/dssSmartHome');
const ActivityCounter = require('./lib/activityCounter');
const configUtils = require('./lib/configUtils');
const dssConstants = require('./lib/constants');

// DSS rules 8/9 (see above) allow at most one cyclic read per minute and circuit.
// One cycle issues TWO reads per circuit (getConsumption + getEnergyMeterValue), and the
// timer for the next cycle only starts once they are answered - measured against a real
// DSS a cycle therefore takes about 20s longer than the configured interval:
//   interval  60s -> cycle  ~80s -> 1.53 requests per minute and circuit
//   interval 100s -> cycle ~120s -> 1.00 requests per minute and circuit
// 100s is the first value that really stays within the rule, so it is the default.
const DEFAULT_POLL_INTERVAL = 100000;
// Smaller values stay possible on purpose - they exceed the guideline, which is documented
// in the README and in the admin dialog. 0 still disables polling completely.
const MIN_POLL_INTERVAL_SECONDS = 60;
const MAX_POLL_INTERVAL_SECONDS = 24 * 60 * 60;

class Digitalstrom extends utils.Adapter {
    /**
     * Returns an objectHelper that belongs to this adapter instance only.
     *
     * The helper of `@apollon/iobroker-tools` keeps its adapter reference, the object queue,
     * the known objects and the state change callbacks in module scope. In compact mode two
     * instances of this adapter share one process, so the instance initialized last would
     * receive the object and state writes of the other one (verified, see testObjectHelper).
     * Loading a private copy of the module per instance keeps them isolated without
     * reimplementing the helper.
     *
     * @param {object} [logger] adapter logger, used only if the private copy is not possible
     * @returns {object} objectHelper instance
     */
    static createObjectHelper(logger) {
        try {
            const modulePath = require.resolve('@apollon/iobroker-tools/lib/objectHelper');
            const cached = require.cache[modulePath];
            delete require.cache[modulePath];
            try {
                return require('@apollon/iobroker-tools/lib/objectHelper');
            } finally {
                // Restore the module cache so other consumers keep their own copy
                if (cached) {
                    require.cache[modulePath] = cached;
                } else {
                    delete require.cache[modulePath];
                }
            }
        } catch (err) {
            // Should not happen, but a shared helper is still better than no adapter at all
            logger &&
                logger.warn &&
                logger.warn(
                    `Could not create a private objectHelper (${configUtils.errorMessage(
                        err,
                    )}). Running a second instance of this adapter in the same compact process is not safe.`,
                );
            return ObjectHelper.objectHelper;
        }
    }

    /**
     * @param {Partial<import('@iobroker/adapter-core').AdapterOptions>} [options]
     */
    constructor(options) {
        super({
            ...options,
            name: 'digitalstrom',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.objectHelper = Digitalstrom.createObjectHelper(this.log);
        this.objectHelper.init(this);
        // undefined (not null) so the type matches the connected flag of the base class.
        // The first setConnected() call writes the state in either case.
        /** @type {boolean|undefined} */
        this.connected = undefined;

        this.dss = null;
        /** @type {DSSSmartHome|null} Client der neuen API, nur wenn eingeschaltet */
        this.smartHome = null;
        this.dssQueue = null;
        this.dssStruct = null;
        this.lastScenes = {};
        // Boolean states whose declared valueTrue/valueFalse did not match what the dSS
        // sent. Each one is reported once per run, see coerceScalarValue().
        /** @type {Set<string>} */
        this.unmappedBooleanStates = new Set();

        this.dataPollInterval = 60000;
        this.dataPollTimeout = null;

        this.restartTimeout = null;
        this.startupTimeout = null;
        this.stopping = false;
        this.stopped = false;
        /** @type {Array<() => void>} */
        this.stopCallbacks = [];
        // Overridable in tests so the unsubscribe guard does not take four seconds
        /** @type {number|undefined} */
        this.stopGuardTimeout = undefined;
        // DSS clients created by the App-Token dialog. They are not part of the normal
        // adapter lifecycle, so they have to be tracked to be closable on unload.
        this.tokenConnections = new Set();
        // Smart Home key creation also lives outside the normal client lifecycle. Abort every
        // in-flight flow on unload so it cannot create a late key or answer a closed dialog.
        this.smartHomeKeyControllers = new Set();
        // Guards against registering the event handlers more than once
        this.eventHandlersRegistered = false;
    }

    /**
     * True as soon as the unload has started.
     *
     * Every asynchronous startup callback has to check this before it creates timers,
     * requests, subscriptions or state subscriptions. Otherwise an answer that arrives
     * during or after the unload would revive an already stopped adapter.
     *
     * @returns {boolean} true if the adapter is stopping or already stopped
     */
    isStopping() {
        return this.stopping || this.stopped;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.main();
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.stopAdapter(callback);
        } catch {
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     *
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj) {
        if (obj) {
            // The object was changed
            this.log.debug(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.debug(`object ${id} deleted`);
        }
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (this.isStopping()) {
            // A control command during the unload would push a new queue entry after the
            // queues were already cleared and the DSS client is about to be closed
            this.log.debug(`Ignoring state change for ${id} - the adapter is stopping`);
            return;
        }
        if (state) {
            // The state was changed
            this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

            this.objectHelper.handleStateChange(id, state);
        } else {
            // The state was deleted
            this.log.debug(`state ${id} deleted`);
        }
    }

    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires "common.message" property to be set to true in io-package.json
     *
     * @param {ioBroker.Message} obj
     */
    onMessage(obj) {
        if (typeof obj === 'object' && obj.message) {
            if (obj.command === 'createSmartHomeKey') {
                if (!obj.callback) {
                    return;
                }
                if (this.isStopping()) {
                    return;
                }
                const messageToken = typeof obj.message.appToken === 'string' ? obj.message.appToken.trim() : '';
                const appToken = messageToken || this.config.appToken;
                if (!appToken) {
                    this.sendTo(
                        obj.from,
                        obj.command,
                        { error: 'Please create or enter the App-Token first, the API key is derived from it.' },
                        obj.callback,
                    );
                    return;
                }
                // Der vorhandene App-Token reicht: er wird zur Session und die erzeugt den
                // Bearer-Key. Der Benutzer muss also kein Passwort erneut eingeben.
                this.log.info(`Creating a Smart Home API key for host ${obj.message.host || this.config.host}`);
                const controller = new AbortController();
                this.smartHomeKeyControllers.add(controller);
                DSSSmartHome.createApiKey({
                    host: obj.message.host || this.config.host,
                    appToken,
                    validateCertificate: this.config.validateCertificate,
                    name: `ioBroker.digitalstrom.${this.instance}`,
                    signal: controller.signal,
                    logger: {
                        silly: this.log.silly.bind(this),
                        debug: this.log.debug.bind(this),
                        info: this.log.info.bind(this),
                        warn: this.log.warn.bind(this),
                        error: this.log.error.bind(this),
                    },
                })
                    .then(
                        apiKey => {
                            if (this.isStopping() || controller.signal.aborted) {
                                return;
                            }
                            this.log.info('Smart Home API key created');
                            this.sendTo(
                                obj.from,
                                obj.command,
                                { apiKey, native: { smartHomeApiKey: apiKey } },
                                obj.callback,
                            );
                        },
                        err => {
                            if (this.isStopping() || controller.signal.aborted) {
                                return;
                            }
                            this.log.warn(`Could not create the Smart Home API key: ${configUtils.errorMessage(err)}`);
                            this.sendTo(obj.from, obj.command, { error: configUtils.errorMessage(err) }, obj.callback);
                        },
                    )
                    .finally(() => this.smartHomeKeyControllers.delete(controller));
                return;
            }
            if (obj.command === 'createAppToken') {
                if (!obj.callback) {
                    return;
                }
                if (this.isStopping()) {
                    // Starting a new connection during the unload would outlive the adapter
                    this.log.debug('Ignoring createAppToken request - the adapter is stopping');
                    return;
                }
                // The username is part of the credentials and is deliberately not logged
                this.log.info(`Try to retrieve AppToken for host ${obj.message.host}`);

                let tokenConnection;
                try {
                    tokenConnection = new DSS({
                        host: obj.message.host,
                        validateCertificate: this.config.validateCertificate,
                        logger: {
                            silly: this.log.silly.bind(this),
                            debug: this.log.debug.bind(this),
                            info: this.log.info.bind(this),
                            warn: this.log.warn.bind(this),
                            error: this.log.error.bind(this),
                        },
                    });
                } catch (err) {
                    // An invalid host throws synchronously - answer the admin dialog instead
                    // of letting the exception escape the message handler
                    this.log.warn(`Can not retrieve AppToken: ${configUtils.errorMessage(err)}`);
                    this.sendTo(obj.from, obj.command, { error: configUtils.errorMessage(err) }, obj.callback);
                    return;
                }

                // Tracked so that an unload can close a token dialog that is still running
                this.tokenConnections.add(tokenConnection);
                let tokenClientClosed = false;
                const closeTokenClient = () => {
                    if (tokenClientClosed) {
                        return;
                    }
                    tokenClientClosed = true;
                    this.tokenConnections.delete(tokenConnection);
                    tokenConnection.stop();
                };

                tokenConnection.createAppTokenAsync(obj.message.username, obj.message.password).then(
                    appToken => {
                        closeTokenClient();
                        if (this.isStopping()) {
                            // The admin dialog is gone with the adapter - no late answer, no log line
                            return;
                        }
                        this.log.info(`Successfully retrieved AppToken for host ${obj.message.host}`);
                        // "native" is used by the jsonConfig sendTo component (useNative) to fill the config field
                        this.sendTo(obj.from, obj.command, { appToken, native: { appToken } }, obj.callback);
                    },
                    error => {
                        closeTokenClient();
                        if (this.isStopping()) {
                            return;
                        }
                        this.log.warn(
                            `Error while retrieving AppToken for host ${obj.message.host}: ${configUtils.errorMessage(
                                error,
                            )}`,
                        );
                        this.sendTo(obj.from, obj.command, { error: configUtils.errorMessage(error) }, obj.callback);
                    },
                );
            }
        }
    }

    stopAdapter(callback) {
        // Every caller has to be answered exactly once, even if a stop is already running
        if (this.stopping) {
            if (this.stopped) {
                return void (callback && callback());
            }
            callback && this.stopCallbacks.push(callback);
            return;
        }
        this.stopping = true;
        this.stopCallbacks = callback ? [callback] : [];
        this.log && this.log.info(`stopping ... ${Date.now()}`);
        this.setConnected(false);

        if (this.dataPollTimeout) {
            clearTimeout(this.dataPollTimeout);
            this.dataPollTimeout = null;
        }
        if (this.apiActivityTimer) {
            clearInterval(this.apiActivityTimer);
            this.apiActivityTimer = null;
        }
        if (this.startupTimeout) {
            clearTimeout(this.startupTimeout);
            this.startupTimeout = null;
        }
        if (this.restartTimeout) {
            clearTimeout(this.restartTimeout);
            this.restartTimeout = null;
        }

        // Close a still running App-Token dialog: its client lives outside the normal
        // lifecycle and would otherwise keep sockets open after the unload
        this.tokenConnections.forEach(connection => {
            try {
                connection.stop();
            } catch (err) {
                this.log && this.log.debug(`Error while closing a token connection: ${configUtils.errorMessage(err)}`);
            }
        });
        this.tokenConnections.clear();

        this.smartHomeKeyControllers?.forEach(controller => controller.abort());
        this.smartHomeKeyControllers?.clear();

        this.dssStruct && this.dssStruct.clearTimeouts();

        // Stop the queue for good: removes all entries, ends the timers and rejects
        // anything that still arrives while the unload is running
        this.dssQueue && this.dssQueue.stop();

        // Central cleanup, runs exactly once no matter which path finished first
        let unsubscribeGuard = null;
        const finish = time => {
            if (this.stopped) {
                return;
            }
            this.stopped = true;
            if (unsubscribeGuard) {
                clearTimeout(unsubscribeGuard);
                unsubscribeGuard = null;
            }
            // Closes the agents and aborts still running requests/long-polls
            this.dss && this.dss.stop();
            this.smartHome && this.smartHome.stop();
            this.log && this.log.info(`cleaned everything up... ${time}`);
            const callbacks = this.stopCallbacks;
            this.stopCallbacks = [];
            callbacks.forEach(cb => {
                try {
                    cb();
                } catch (err) {
                    this.log && this.log.debug(`Error in unload callback: ${configUtils.errorMessage(err)}`);
                }
            });
        };

        // unsubscribe to all events
        if (this.dss) {
            unsubscribeGuard = setTimeout(() => {
                unsubscribeGuard = null;
                this.log && this.log.info('unsubscribe did not finish in time, stopping anyway');
                finish(0);
            }, this.stopGuardTimeout || 4000);
            this.dss.unsubscribeAllEvents(time => finish(time));
        } else {
            finish(0);
        }
    }

    restartAdapter(timeout) {
        if (this.restartTimeout || this.isStopping()) {
            return;
        }
        this.restartTimeout = setTimeout(() => {
            this.restartTimeout = null;
            // terminate() is provided by adapter-core and is the only safe way to end an
            // adapter - process.exit() would kill the whole host process in compact mode
            this.terminate(-100);
        }, timeout || 1000);
    }

    /**
     * @param {boolean} isConnected
     */
    setConnected(isConnected) {
        if (isConnected && this.isStopping()) {
            // A late startup callback must never mark an already stopped adapter as connected
            this.log && this.log.debug('Ignoring connected = true, the adapter is stopping');
            return;
        }
        if (this.connected !== isConnected) {
            this.connected = isConnected;
            this.setState('info.connection', isConnected, true);
        }
    }

    /**
     * Brings the boolean options into a defined state.
     *
     * The instance object can be written by hand, by a script or by a restored backup, so
     * a value can arrive as the string "false". Plain truthiness would read that as true -
     * for deleteUnknownObjects that would silently enable deleting objects including their
     * custom settings (history, influxdb, ...).
     */
    normalizeConfig() {
        // option name -> safe default, matching "native" in io-package.json
        const booleanDefaults = {
            usePresetValues: true,
            initializeOutputValues: true,
            deleteUnknownObjects: false,
            validateCertificate: false,
        };
        Object.keys(booleanDefaults).forEach(name => {
            const raw = this.config[name];
            const normalized = configUtils.normalizeBoolean(raw, booleanDefaults[name]);
            if (raw !== undefined && !configUtils.isInterpretableBoolean(raw)) {
                // Never fail silently - especially not for the certificate check
                this.log.warn(
                    `Configuration value "${name}" is not a valid boolean (${JSON.stringify(
                        raw,
                    )}), using the default ${normalized}. Please check the adapter settings.`,
                );
            }
            this.config[name] = normalized;
        });
    }

    main() {
        // Reset the connection indicator during startup
        this.setConnected(false);
        this.normalizeConfig();

        if (!this.config.host || !this.config.appToken) {
            this.log.warn('Please open Admin page for this adapter to set the host and create an App Token.');
            return;
        }
        if (!Digitalstrom.looksLikeAppToken(this.config.appToken)) {
            this.log.error(
                'The stored App-Token does not look like a valid digitalSTROM token (expected a long hex ' +
                    'string). Please open the adapter configuration, enter the App-Token again or create a new ' +
                    'one with your DSS login, and save. The adapter tries to log in anyway.',
            );
        }
        // Zaehlt je Weg, was wirklich laeuft - der Status-Tab zeigt daraus
        // "x empfangen / y gesendet in den letzten 10 Minuten"
        this.apiActivity = new ActivityCounter();
        let dss;
        try {
            dss = new DSS({
                host: this.config.host,
                appToken: this.config.appToken,
                validateCertificate: this.config.validateCertificate,
                onActivity: (kind, detail) => this.countClassicActivity(kind, detail),
                logger: {
                    silly: this.log.silly.bind(this),
                    debug: this.log.debug.bind(this),
                    info: this.log.info.bind(this),
                    warn: this.log.warn.bind(this),
                    error: this.log.error.bind(this),
                },
            });
        } catch (err) {
            // An invalid host is a configuration error - restarting would only loop.
            // The adapter stays idle until the configuration is corrected (which restarts it).
            this.dss = null;
            this.log.error(
                `${configUtils.errorMessage(err)}. Please correct the host in the adapter configuration - the adapter stays inactive until then.`,
            );
            return;
        }
        this.dss = dss;
        this.smartHome = this.createSmartHomeClient();
        // 30 s Takt reicht: der Status-Tab zeigt ein 10-Minuten-Fenster
        this.apiActivityTimer = setInterval(() => this.publishApiActivity(), 30000);
        const dssQueue = new DSSQueue({
            logger: {
                silly: this.log.silly.bind(this),
                debug: this.log.debug.bind(this),
                info: this.log.info.bind(this),
                warn: this.log.warn.bind(this),
                error: this.log.error.bind(this),
            },
            dss,
        });
        this.dssQueue = dssQueue;
        const dssStruct = new DSSStructure({
            dss,
            dssQueue,
            adapter: this,
            smartHome: this.smartHome,
        });
        this.dssStruct = dssStruct;

        this.dataPollInterval = Digitalstrom.normalizePollInterval(this.config.dataPollInterval);

        // Watchdog: if initialization does not finish in time (e.g. a stuck request
        // or a DSS that stops responding mid-init), restart the adapter
        this.startupTimeout = setTimeout(() => {
            this.startupTimeout = null;
            this.log.warn('Initialization did not finish within 10 minutes, restarting adapter');
            this.restartAdapter(1000);
        }, 600000);

        dss.requestAsync('apartment', 'getName').then(
            dssName => {
                // Every step checks the stop barrier: an answer that arrives during the
                // unload must not create new objects, timers or subscriptions any more.
                if (this.isStopping()) {
                    return;
                }
                this.log.debug(`getName: ${JSON.stringify(dssName)}`);

                this.objectHelper.loadExistingObjects(() => {
                    if (this.isStopping()) {
                        return;
                    }
                    this.initializeDSSData(err => {
                        if (this.isStopping()) {
                            return;
                        }
                        if (err) {
                            this.log.warn(`Error while initializing Data: ${err}`);
                            this.restartAdapter(60000);
                            return;
                        }

                        this.registerObjects();
                        this.objectHelper.processObjectQueue(() => {
                            if (this.isStopping()) {
                                return;
                            }
                            // From here on all objects exist, so values may be written directly
                            dssStruct.objectsReady = true;
                            this.setInitialValues(() => {
                                if (this.isStopping()) {
                                    return;
                                }
                                this.lastScenes = dssStruct.initialScenes;
                                // Subscribe right away: every millisecond between the initial
                                // snapshot and the active subscription is a window in which
                                // scene calls are lost for good.
                                this.initializeSubscriptions(subscriptionErr => {
                                    if (this.isStopping()) {
                                        return;
                                    }
                                    if (subscriptionErr) {
                                        // Without events the adapter would silently miss every
                                        // change, so this must not be treated as a running adapter
                                        this.log.error(
                                            `Could not subscribe to the DSS events: ${subscriptionErr.message}`,
                                        );
                                        this.setConnected(false);
                                        if (this.startupTimeout) {
                                            clearTimeout(this.startupTimeout);
                                            this.startupTimeout = null;
                                        }
                                        // Drop the partially created subscriptions before restarting
                                        dss.unsubscribeAllEvents(() => this.restartAdapter(30000));
                                        return;
                                    }
                                    this.subscribeStates('*');
                                    this.setConnected(true);
                                    if (this.startupTimeout) {
                                        clearTimeout(this.startupTimeout);
                                        this.startupTimeout = null;
                                    }
                                    this.log.info('Subscribed to states ...');

                                    this.startDataPolling();

                                    // Catches scene calls that happened while the structure
                                    // was being built, see resyncSceneStates()
                                    this.resyncSceneStates();

                                    this.clearAdditionalObjects();

                                    this.startNotificationChannel();
                                });
                            });
                        });
                    });
                });
            },
            err => {
                if (this.isStopping()) {
                    return;
                }
                this.log.error(
                    `Error while checking DSS connection (getName):${(err && err.message) || JSON.stringify(err)}`,
                );
                this.log.error(
                    'Please check the host and that the host is reachable and check the settings please! Adapter restarts in 5 minutes',
                );
                this.restartAdapter(300000);
            },
        );
    }

    /**
     * Re-reads the last called scene of every known zone group once the event
     * subscription is active.
     *
     * The initial scene snapshot is taken while the structure is being read, which can
     * take minutes on large installations. A scene called between that snapshot and the
     * active subscription appears neither in the snapshot nor in an event, so the states
     * would stay wrong until the next scene call. The re-read uses the lowest priority so
     * it never delays a user command, and only a really changed scene is applied - through
     * the normal event path, so all follow up handling stays identical.
     *
     * @param {() => void} [callback]
     */
    resyncSceneStates(callback) {
        // Group keys look like "<zoneId>.<groupId>", device keys are dSUIDs without a dot
        const groupKeys = Object.keys(this.lastScenes || {}).filter(key => /^\d+\.\d+$/.test(key));
        const dss = this.dss;
        const dssQueue = this.dssQueue;
        if (!groupKeys.length || this.isStopping() || !dssQueue || !dss) {
            return void (callback && callback());
        }
        this.log.debug(`Checking the scenes of ${groupKeys.length} zone groups for changes during the startup`);
        let open = groupKeys.length;
        const done = () => {
            if (!--open) {
                callback && callback();
            }
        };
        groupKeys.forEach(key => {
            const [zoneId, groupId] = key.split('.');
            dssQueue.pushQueryQueue(
                'zone',
                {
                    dssClass: 'zone',
                    dssFunction: 'getLastCalledScene',
                    params: {
                        id: zoneId,
                        groupID: groupId,
                    },
                },
                'low',
                (err, res) => {
                    if (this.isStopping()) {
                        return void done();
                    }
                    if (err || !res || !res.ok || !res.result || res.result.scene === undefined) {
                        this.log.debug(
                            `Could not check the scene of zone group ${key}: ${
                                (err && err.message) || JSON.stringify(res)
                            }`,
                        );
                        return void done();
                    }
                    if (String(res.result.scene) === String(this.lastScenes[key])) {
                        return void done();
                    }
                    this.log.info(
                        `Scene of zone group ${key} changed to ${res.result.scene} while the adapter was starting - applying it now`,
                    );
                    dss.emit('callScene', {
                        name: 'callScene',
                        source: { isDevice: false, isGroup: true, isApartment: false },
                        properties: {
                            zoneID: String(zoneId),
                            groupID: String(groupId),
                            sceneID: String(res.result.scene),
                            callOrigin: '-1',
                        },
                    });
                    done();
                },
            );
        });
    }

    /**
     * True when the value looks like a digitalSTROM application token.
     *
     * The DSS issues a long hex string. A stored value that does not look like one usually
     * means js-controller could not decrypt it, and the login would fail with nothing but
     * "Login failed" - which gives the user no clue what to do.
     *
     * Deliberately only a plausibility check - it never blocks the login, it only produces a
     * helpful message.
     *
     * @param {unknown} token configured app token
     * @returns {boolean} true if the value can be a valid token
     */
    static looksLikeAppToken(token) {
        return typeof token === 'string' && /^[0-9a-f]{32,}$/i.test(token.trim());
    }

    /**
     * Sorts classic API activity into the counters of the status tab.
     *
     * @param {string} kind 'request' | 'eventPoll' | 'event'
     * @param {string} detail request path or event name
     */
    countClassicActivity(kind, detail) {
        if (!this.apiActivity) {
            return;
        }
        if (kind === 'event') {
            return void this.apiActivity.count('classic.events');
        }
        if (kind === 'eventPoll') {
            // Der permanente Long-Poll ist Zuhoeren, kein Arbeitsauftrag - er wuerde
            // die Request-Zahl nur kuenstlich aufblasen
            return;
        }
        this.apiActivity.count('classic.requests');
        if (detail.includes('/json/metering/')) {
            this.apiActivity.count('classic.meterReads');
        } else if (
            detail.includes('getOutputValue') ||
            // covers the named channel read of vDC devices in both spellings,
            // getOutputChannelValue and getOutputChannelValue2
            detail.includes('getOutputChannelValue') ||
            detail.includes('getConfig')
        ) {
            this.apiActivity.count('classic.outputReads');
        } else if (
            /callScene|undoScene|setValue|setOutputValue|\/state\/set|pushSensorValue|setTemperatureControlValues|\/event\/raise/.test(
                detail,
            )
        ) {
            // Geschriebene Befehle - die zweite Richtung der Ereignisse-und-Steuerung-Zeile
            this.apiActivity.count('classic.commands');
        }
    }

    /**
     * @param {string} kind currently always 'request'
     * @param {string} apiPath
     */
    countSmartHomeActivity(kind, apiPath) {
        if (!this.apiActivity || kind !== 'request') {
            return;
        }
        this.apiActivity.count('smarthome.requests');
        if (apiPath.includes('/meterings/values')) {
            this.apiActivity.count('smarthome.meterReads');
        } else if (apiPath.includes('/apartment/status')) {
            this.apiActivity.count('smarthome.statusReads');
        }
    }

    /**
     * Writes the rolling 10 minute activity into info.apiActivity, at most every
     * 30 seconds. The status tab of the settings renders it live - that is the
     * proof that a path really works, not just that it is configured.
     */
    publishApiActivity() {
        if (this.isStopping() || !this.apiActivity) {
            return;
        }
        const counts = this.apiActivity.snapshot();
        const payload = JSON.stringify({
            windowMinutes: 10,
            classic: {
                requests: counts['classic.requests'] || 0,
                events: counts['classic.events'] || 0,
                commands: counts['classic.commands'] || 0,
                meterReads: counts['classic.meterReads'] || 0,
                outputReads: counts['classic.outputReads'] || 0,
            },
            smarthome: {
                requests: counts['smarthome.requests'] || 0,
                meterReads: counts['smarthome.meterReads'] || 0,
                statusReads: counts['smarthome.statusReads'] || 0,
                notifications: counts['smarthome.notifications'] || 0,
            },
        });
        if (payload === this.lastApiActivityPayload) {
            return;
        }
        this.lastApiActivityPayload = payload;
        this.setState('info.apiActivity', payload, true);
    }

    /**
     * Opens the notification websocket of the Smart Home API as a safety net.
     *
     * The notifications carry no payload - they only say THAT something changed, and
     * they fire for every meter tick. Everything driven by buttons and scenes is
     * already reported precisely by the classic events, so the reaction here is a
     * hard rate-limited reconciliation (see DSSStructure.reconcileOutputValues): it
     * catches changes made past ioBroker, e.g. a third-party app writing an output
     * directly. The client reconnects on its own; a dSS without the websocket just
     * leaves the adapter running like before.
     */
    startNotificationChannel() {
        if (!this.smartHome || !this.dssStruct) {
            return;
        }
        this.smartHome.on('statusChanged', () => {
            if (this.isStopping() || !this.dssStruct) {
                return;
            }
            if (this.dssStruct.reconcileOutputValues()) {
                this.log.debug('Smart Home notification: reconciling the output values');
            }
        });
        this.smartHome.on('structureChanged', () => {
            // The classic model_ready event reports the same and restarts the adapter
            this.log.debug('The dSS reports a structure change');
        });
        this.smartHome.on('notificationConnected', () => this.log.debug('Smart Home notification channel connected'));
        this.smartHome.on('notification', () => this.apiActivity && this.apiActivity.count('smarthome.notifications'));
        this.smartHome.startNotifications().then(
            () =>
                this.log.info(
                    'Smart Home notification channel is active - changes made outside of ioBroker are reconciled automatically',
                ),
            err =>
                this.log.info(
                    `Smart Home notification channel is not available (${configUtils.errorMessage(err)}) - the adapter works without it`,
                ),
        );
    }

    /**
     * Creates the client for the new Smart Home API, if it is switched on and configured.
     *
     * Returns null in every other case. The adapter then behaves exactly as before: the
     * classic API stays the fallback for everything, so a missing key or an unreachable
     * host must never keep the adapter from starting.
     *
     * @returns {DSSSmartHome|null}
     */
    createSmartHomeClient() {
        if (!configUtils.normalizeBoolean(this.config.useSmartHomeApi, false)) {
            return null;
        }
        if (!this.config.smartHomeApiKey && !this.dss) {
            this.log.warn(
                'The Smart Home API is switched on but there is neither an API key nor a connection to the ' +
                    'classic interface - falling back to the classic API',
            );
            return null;
        }
        if (!this.config.smartHomeApiKey) {
            // The new API also accepts the login of the classic interface (measured for
            // every endpoint this adapter reads and for the notification websocket), so
            // a key is a convenience, not a requirement
            this.log.info(
                'No Smart Home API key configured - using the login of the classic interface for the new API',
            );
        }
        // Same reasoning as for the app token: a value that is not a hex string usually
        // means js-controller could not decrypt it (e.g. after restoring a backup on
        // another host), and the dSS would only answer with an anonymous 401
        if (this.config.smartHomeApiKey && !Digitalstrom.looksLikeAppToken(this.config.smartHomeApiKey)) {
            this.log.error(
                'The stored Smart Home API key does not look like a valid key (expected a long hex string). ' +
                    'Please open the adapter configuration, create the API key again and save. ' +
                    'The adapter tries to use it anyway.',
            );
        }
        try {
            const client = new DSSSmartHome({
                host: this.config.host,
                apiKey: this.config.smartHomeApiKey,
                // The session of the classic client, renewed by it: serves without a
                // key, and catches a key the dSS revoked without taking the path down
                getSessionToken: this.dss
                    ? forceRenew => {
                          const dss = /** @type {any} */ (this.dss);
                          forceRenew && dss.invalidateSession();
                          return dss.getSessionToken();
                      }
                    : undefined,
                validateCertificate: this.config.validateCertificate,
                onActivity: (kind, apiPath) => this.countSmartHomeActivity(kind, apiPath),
                logger: {
                    silly: this.log.silly.bind(this),
                    debug: this.log.debug.bind(this),
                    info: this.log.info.bind(this),
                    warn: this.log.warn.bind(this),
                    error: this.log.error.bind(this),
                },
            });
            this.log.info(
                'Smart Home API is active: meter values are read with one request instead of two per ' +
                    'circuit, and device output values with one status request instead of one read per channel',
            );
            return client;
        } catch (err) {
            this.log.warn(
                `Could not create the Smart Home API client (${configUtils.errorMessage(err)}) - falling back to the classic API`,
            );
            return null;
        }
    }

    /**
     * Validates the configured polling interval independently of the admin UI.
     * Invalid values must never produce an aggressive timer.
     *
     * @param {unknown} configuredSeconds raw value from the instance config
     * @returns {number} interval in ms, 0 means polling is disabled
     */
    static normalizePollInterval(configuredSeconds) {
        if (configuredSeconds === undefined || configuredSeconds === null || configuredSeconds === '') {
            return DEFAULT_POLL_INTERVAL;
        }
        const seconds = Number(configuredSeconds);
        if (!Number.isFinite(seconds)) {
            return DEFAULT_POLL_INTERVAL;
        }
        if (seconds <= 0) {
            return 0; // explicitly disabled
        }
        return Math.min(Math.max(Math.round(seconds), MIN_POLL_INTERVAL_SECONDS), MAX_POLL_INTERVAL_SECONDS) * 1000;
    }

    initializeDSSData(callback) {
        const dss = this.dss;
        const dssStruct = this.dssStruct;
        if (!dss || !dssStruct) {
            return void (callback && callback('No DSS connection available'));
        }
        dss.requestAsync('system', 'version').then(
            dssVersion => {
                this.log.debug(`version: ${JSON.stringify(dssVersion)}`);

                dssStruct.init(err => {
                    if (err) {
                        return void (callback && callback(err));
                    }

                    callback && callback(null);
                });
            },
            err => {
                this.log.error(`Error getVersion:${(err && err.message) || JSON.stringify(err)}`);
                callback && callback(err);
            },
        );
    }

    startDataPolling(fromTimeout) {
        if (this.dataPollTimeout) {
            !fromTimeout && clearTimeout(this.dataPollTimeout);
            this.dataPollTimeout = null;
        }
        if (this.isStopping()) {
            return;
        }
        if (this.dataPollInterval === 0) {
            this.log.info('Data polling deactivated.');
            return;
        }
        const dssStruct = this.dssStruct;
        if (!dssStruct) {
            return;
        }
        dssStruct.updateMeterData((failed, total) => {
            if (this.isStopping()) {
                return;
            }
            // If every single meter request failed the DSS is most likely unreachable
            if (total > 0) {
                this.setConnected(failed < total);
            }
            this.dataPollTimeout = setTimeout(() => this.startDataPolling(true), this.dataPollInterval);
        });
    }

    initializeSubscriptions(callback) {
        const eventNames = Object.keys(dssConstants.availableEvents).filter(name => dssConstants.availableEvents[name]);
        if (!this.dss) {
            return void (callback && callback(new Error('No DSS connection available')));
        }
        // Handlers first, subscriptions second - see registerEventHandlers()
        this.registerEventHandlers(eventNames);
        this.dss.subscribeEvents(eventNames, errs => {
            let subscriptionError = null;
            if (errs && Array.isArray(errs) && errs.length) {
                this.log.warn(`Error to subscribe to ${errs.length} events. See the following log lines.`);
                errs.forEach((err, idx) => this.log.warn(`${idx}: ${(err && err.message) || err}`));
                subscriptionError = new Error(
                    `${errs.length} of ${eventNames.length} event subscriptions failed: ${errs
                        .map(err => (err && err.message) || err)
                        .join('; ')}`,
                );
            } else {
                this.log.debug(`Successfully subscribed to ${eventNames.length} Events`);
            }

            callback && callback(subscriptionError);
        });
    }

    /**
     * Registers all event handlers on the DSS client.
     *
     * This must happen BEFORE subscribeEvents() is called: all events share one
     * subscription id, and its long-poll starts as soon as the last subscription
     * succeeded - before subscribeEvents() answers its own callback. Registering the
     * handlers only in that callback would silently drop the events of the first poll,
     * and those events are consumed on the DSS and lost for good.
     *
     * Idempotent: a second call must not add a second set of listeners.
     *
     * @param {string[]} eventNames all subscribed event names
     */
    registerEventHandlers(eventNames) {
        if (this.eventHandlersRegistered || !this.dss || !this.dssStruct) {
            return;
        }
        this.eventHandlersRegistered = true;
        // Captured once: both are created together in main() and are never replaced
        // afterwards. The local constants also keep the handlers free of repeated null checks.
        const dss = this.dss;
        const dssStruct = this.dssStruct;
        dss.on('deviceSensorValue', data => {
            this.eventLog(data.name, data, true);
            if (!data.source || !data.source.isDevice || data.properties.sensorValueFloat === undefined) {
                this.log.info(`--INVALID ${JSON.stringify(data)}`);
                return;
            }
            const sourceDeviceId = dssStruct.stateMap[`${data.source.dSUID}.sensors.${data.properties.sensorIndex}`];
            if (!sourceDeviceId) {
                this.log.info('INVALID Device Sensor update');
                return;
            }
            this.setDssState(sourceDeviceId, data.properties.sensorValueFloat);
        });

        dss.on('deviceBinaryInputEvent', data => {
            this.eventLog(data.name, data, true);
            if (!data.source || !data.source.isDevice || data.properties.inputType === undefined) {
                this.log.info(`--INVALID ${JSON.stringify(data)}`);
                return;
            }
            const sourceDeviceId =
                dssStruct.stateMap[`${data.source.dSUID}.binaryInputs.${data.properties.inputIndex}`];
            if (!sourceDeviceId) {
                this.log.info('INVALID Device Binary input event');
                return;
            }
            this.setDssState(sourceDeviceId, parseInt(data.properties.inputState, 10) + 1);
        });

        const handleStateChange = data => {
            this.eventLog(data.name, data, true);
            if (!data.properties || !data.properties.statename) {
                this.log.info(`--INVALID ${JSON.stringify(data)}`);
                return;
            }
            const sourceDeviceId = dssStruct.stateMap[data.properties.statename];
            if (!sourceDeviceId) {
                if (data.name === 'addonStateChange') {
                    // Helper states of dSS addons (e.g. "<dsuid>_open-tilded" of the
                    // window-states addon) have no ioBroker object by design - the
                    // window state itself arrives via binary input and device state
                    this.log.debug(`Unhandled State Change: ${data.properties.statename}`);
                } else {
                    this.log.info(`Unhandled State Change: ${data.properties.statename}`);
                }
                return;
            }
            // The valueTrue/valueFalse mapping of the state is applied by setDssState()
            this.setDssState(sourceDeviceId, data.properties.state);
        };
        dss.on('stateChange', handleStateChange);
        dss.on('addonStateChange', handleStateChange);

        dss.on('buttonClick', data => {
            this.eventLog(data.name, data, true);
            if (!data.source || !data.source.isDevice) {
                this.log.info(`--INVALID ${JSON.stringify(data)}`);
                return;
            }
            const buttonIndex = data.properties.buttonIndex ? data.properties.buttonIndex - 1 : 0;
            if (!dssStruct.stateMap[`${data.source.dSUID}.${buttonIndex}.button`]) {
                this.log.info('INVALID Button click');
                return;
            }
            this.setState(dssStruct.stateMap[`${data.source.dSUID}.${buttonIndex}.button`], true, true);
            // setDssState, not setState: the DSS delivers the click type and the hold count as
            // strings while both objects are declared as numbers. The ids can be missing on
            // devices that only have the plain button state.
            const clickTypeId = dssStruct.stateMap[`${data.source.dSUID}.${buttonIndex}.buttonClickType`];
            clickTypeId && this.setDssState(clickTypeId, data.properties.clickType ?? -1);
            const holdCountId = dssStruct.stateMap[`${data.source.dSUID}.${buttonIndex}.buttonHoldCount`];
            holdCountId && this.setDssState(holdCountId, data.properties.holdCount ?? 0);
        });

        dss.on('zoneSensorValue', data => {
            this.eventLog(data.name, data, true);
            if (
                !data.source ||
                !data.properties ||
                !data.properties.sensorType ||
                data.properties.sensorValueFloat === undefined
            ) {
                this.log.info(`--INVALID ${JSON.stringify(data)}`);
                return;
            }
            let sourceDeviceId = dssStruct.stateMap[`${data.source.zoneID}.sensors.${data.properties.sensorType}`];
            if (!sourceDeviceId && data.properties.sensorType === 60) {
                sourceDeviceId = dssStruct.stateMap['0.sensors.60'];
            }
            if (!sourceDeviceId) {
                this.log.info(
                    `INVALID Zone Sensor update: ${data.source.zoneID}.sensors.${data.properties.sensorType}`,
                );
                return;
            }
            this.setDssState(sourceDeviceId, data.properties.sensorValueFloat);
        });

        /**
         * Hands a scene event to the device handlers of the affected devices.
         *
         * zoneDevices is keyed by the real device groups (1, 2, 8 ...) only - the DSS never
         * lists a device in the broadcast group 0. A scene called for a whole room therefore
         * arrives with groupID "0" and has to be fanned out over every group of that room,
         * exactly like the apartment wide broadcast does.
         *
         * @param {string} zoneId zone of the scene event
         * @param {string} groupId group of the scene event, "0" means the whole room
         * @param {object} data the scene event itself
         */
        const emitSceneToDevices = (zoneId, groupId, data) => {
            const groups = dssStruct.zoneDevices[zoneId];
            if (!groups) {
                return;
            }
            if (String(groupId) !== '0') {
                (groups[groupId] || []).forEach(dSUID => dss.emit(dSUID, data));
                return;
            }
            const handledDevices = {};
            Object.keys(groups).forEach(group =>
                groups[group].forEach(dSUID => {
                    if (!handledDevices[dSUID]) {
                        handledDevices[dSUID] = true;
                        dss.emit(dSUID, data);
                    }
                }),
            );
        };

        const handleScene = (data, value, forwarded) => {
            this.eventLog(data.name + (forwarded ? ' (forwarded)' : ''), data, true);
            if (!data.source) {
                this.log.info(`--INVALID ${JSON.stringify(data)}`);
                return;
            }
            let sourceDeviceId;
            let lastSourceDeviceId;

            if (data.source.isDevice) {
                sourceDeviceId = dssStruct.stateMap[`${data.source.dSUID}.scenes.${data.properties.sceneID}`];
                if (this.lastScenes[data.source.dSUID] !== undefined) {
                    lastSourceDeviceId =
                        dssStruct.stateMap[`${data.source.dSUID}.scenes.${this.lastScenes[data.source.dSUID]}`];
                }
                if (value) {
                    this.lastScenes[data.source.dSUID] = data.properties.sceneID;
                } else {
                    this.lastScenes[data.source.dSUID] = undefined;
                }

                dss.emit(data.source.dSUID, data);
            } else if (data.source.isGroup && (data.properties.zoneID !== '0' || data.properties.groupID !== '0')) {
                sourceDeviceId =
                    dssStruct.stateMap[
                        `${data.properties.zoneID}.${data.properties.groupID}.scenes.${data.properties.sceneID}`
                    ];
                if (this.lastScenes[`${data.properties.zoneID}.${data.properties.groupID}`] !== undefined) {
                    lastSourceDeviceId =
                        dssStruct.stateMap[
                            `${data.properties.zoneID}.${data.properties.groupID}.scenes.${
                                this.lastScenes[`${data.properties.zoneID}.${data.properties.groupID}`]
                            }`
                        ];
                }
                if (value) {
                    this.lastScenes[`${data.properties.zoneID}.${data.properties.groupID}`] = data.properties.sceneID;
                } else {
                    this.lastScenes[`${data.properties.zoneID}.${data.properties.groupID}`] = undefined;
                }

                // No initializeOutputValues check here: the device handlers also apply the
                // scene preset values (usePresetValues) and gate the real DSS read on that
                // option themselves.
                if (!forwarded) {
                    emitSceneToDevices(data.properties.zoneID, data.properties.groupID, data);
                }
            } else if (
                data.source.isApartment ||
                (data.source.isGroup && data.properties.zoneID === '0' && data.properties.groupID === '0')
            ) {
                sourceDeviceId = dssStruct.stateMap[`0.0.scenes.${data.properties.sceneID}`];
                if (this.lastScenes['0.0'] !== undefined) {
                    lastSourceDeviceId = dssStruct.stateMap[`0.0.scenes.${this.lastScenes['0.0']}`];
                }
                if (value) {
                    this.lastScenes['0.0'] = data.properties.sceneID;
                } else {
                    this.lastScenes['0.0'] = undefined;
                }

                if (!forwarded) {
                    const handledDevices = {};
                    Object.keys(dssStruct.zoneDevices).forEach(zoneId => {
                        Object.keys(dssStruct.zoneDevices[zoneId]).forEach(groupId => {
                            dssStruct.zoneDevices[zoneId][groupId].forEach(dSUID => {
                                if (!handledDevices[dSUID]) {
                                    dss.emit(dSUID, data);
                                    handledDevices[dSUID] = true;
                                }
                            });
                        });
                    });
                }
            }

            if (sourceDeviceId) {
                this.setDssState(sourceDeviceId, value);
                lastSourceDeviceId &&
                    lastSourceDeviceId !== sourceDeviceId &&
                    value &&
                    this.setDssState(lastSourceDeviceId, false);
                const idArr = sourceDeviceId.split('.');
                idArr[idArr.length - 1] = 'sceneId';
                const sceneIdState = idArr.join('.');
                if (value) {
                    this.setDssState(sceneIdState, data.properties.sceneID);
                } else {
                    this.setDssState(sceneIdState, null);
                }
                // The room temperature control is switched through the scenes of group 48.
                // Keep the readable operation mode of that room in sync with them.
                if (value && String(data.properties.groupID) === '48') {
                    const operationModeState = dssStruct.stateMap[`${data.properties.zoneID}.48.operationMode`];
                    operationModeState && this.setDssState(operationModeState, data.properties.sceneID);
                }
            } else {
                !forwarded && this.log.info('INVALID scenecall');
            }

            // When Scene is called on zone level we also update all groups in that zone
            if (data.source.isGroup && data.properties.zoneID !== '0' && data.properties.groupID === '0') {
                if (dssStruct.zoneDevices[data.properties.zoneID]) {
                    Object.keys(dssStruct.zoneDevices[data.properties.zoneID]).forEach(group => {
                        data.properties.groupID = group.toString();
                        handleScene(data, value, true);
                    });
                }
            } else if (data.source.isGroup && data.properties.zoneID === '0' && data.properties.groupID === '0') {
                dssStruct.apartmentStructure.zones.forEach(zone => {
                    if (!dssStruct.zoneDevices[zone.id]) {
                        return;
                    }
                    data.properties.zoneID = zone.id.toString();
                    Object.keys(dssStruct.zoneDevices[zone.id]).forEach(group => {
                        data.properties.groupID = group.toString();
                        handleScene(data, value, true);
                    });
                });
            }

            //console.log('Check Button: ' + dssStruct.stateMap[data.properties.originDSUID + '.0.button']);
            if (!forwarded && data.properties.callOrigin === '9') {
                if (data.properties.originDSUID && dssStruct.stateMap[`${data.properties.originDSUID}.0.button`]) {
                    this.setState(dssStruct.stateMap[`${data.properties.originDSUID}.0.button`], true, true);
                    dssStruct.stateMap[`${data.properties.originDSUID}.0.buttonClickType`] &&
                        this.setState(dssStruct.stateMap[`${data.properties.originDSUID}.0.buttonClickType`], 0, true);
                    dssStruct.stateMap[`${data.properties.originDSUID}.0.buttonHoldCount`] &&
                        this.setState(dssStruct.stateMap[`${data.properties.originDSUID}.0.buttonHoldCount`], 0, true);
                } else if (data.source.dSUID && dssStruct.stateMap[`${data.source.dSUID}.0.button`]) {
                    this.setState(dssStruct.stateMap[`${data.source.dSUID}.0.button`], true, true);
                    dssStruct.stateMap[`${data.source.dSUID}.0.buttonClickType`] &&
                        this.setState(dssStruct.stateMap[`${data.source.dSUID}.0.buttonClickType`], 0, true);
                    dssStruct.stateMap[`${data.source.dSUID}.0.buttonHoldCount`] &&
                        this.setState(dssStruct.stateMap[`${data.source.dSUID}.0.buttonHoldCount`], 0, true);
                }
            }
        };

        dss.on('callScene', data => handleScene(data, true));
        dss.on('undoScene', data => handleScene(data, false));

        dss.on('eventError', (eventName, errorCount, err) => {
            this.log.warn(`Too many event polling errors (${eventName}): ${err} - restarting adapter`);
            this.setConnected(false);
            this.restartAdapter(2000);
        });

        dss.on('model_ready', () => {
            // The DSS finished (re-)initializing its apartment model, e.g. after a DSS
            // restart or structure change - restart to resync structure and subscriptions
            this.log.info(
                'DSS apartment model was (re-)initialized (model_ready event) - restarting adapter to resync the structure',
            );
            this.restartAdapter(10000);
        });
        // Log unhandled Events to see what happens so at all
        eventNames.forEach(
            eventName =>
                dss.listenerCount(eventName) === 0 && dss.on(eventName, data => this.eventLog(eventName, data, false)),
        );
    }

    /**
     * Converts a single DSS value to the type declared for the ioBroker object.
     *
     * The DSS delivers numeric values as strings in many places, so js-controller would
     * otherwise complain about the type of every sensor value, scene id and state.
     *
     * @param {string} id
     * @param {unknown} value
     * @returns {ioBroker.StateValue} value converted to the declared type
     */
    coerceScalarValue(id, value) {
        if (value === null || value === undefined) {
            return null;
        }
        const obj = this.dssStruct && this.dssStruct.dssObjects && this.dssStruct.dssObjects[id];
        const type = obj && obj.common && obj.common.type;
        if (type === 'number' && typeof value !== 'number') {
            const numeric = parseFloat(String(value));
            return Number.isNaN(numeric) ? null : numeric;
        }
        if (type === 'boolean' && typeof value !== 'boolean') {
            // Prefer the value mapping the DSS reported for this state
            const native = obj.native || {};
            if (native.valueTrue !== undefined && value === native.valueTrue) {
                return true;
            }
            if (native.valueFalse !== undefined && value === native.valueFalse) {
                return false;
            }
            if (native.valueTrue !== undefined || native.valueFalse !== undefined) {
                // This is the only signal that a declared vocabulary has gone stale, and it
                // sat on debug: on a real installation it fired five times at startup and
                // nobody ever saw it. It warns once per state now - the value itself still
                // comes out right through the toBoolean fallback, so this is a report worth
                // filing, not a failure. Once per state, because a state that keeps sending
                // the unknown word must not fill the log with it.
                if (!this.unmappedBooleanStates.has(id)) {
                    this.unmappedBooleanStates.add(id);
                    this.log.warn(
                        `Unmapped value "${value}" for boolean state ${id} (expected "${native.valueTrue}"/"${native.valueFalse}") - the value was interpreted, please report this state and value so the mapping can be corrected`,
                    );
                }
            }
            return DSSStructure.toBoolean(value);
        }
        if (type === 'string' && typeof value !== 'string') {
            return String(value);
        }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return value;
        }
        // Everything else (objects, arrays, functions) has no representation as a state value
        return null;
    }

    /**
     * Converts a value that came from the DSS for writing it into a state.
     *
     * Beside plain values the adapter also passes whole state objects around: the outdoor
     * sensors carry the timestamp of the DSS, which has to be preserved. Only the value
     * itself is converted in that case.
     *
     * @param {string} id
     * @param {unknown} value
     * @returns {ioBroker.SettableState|ioBroker.StateValue|undefined} converted value, undefined stays undefined
     */
    coerceStateValue(id, value) {
        if (value === undefined) {
            // Kept as undefined on purpose: the callers use it as "no value at all"
            return undefined;
        }
        if (value === null) {
            return null;
        }
        if (typeof value === 'object' && !Array.isArray(value) && 'val' in value && value.val !== undefined) {
            const state = /** @type {ioBroker.SettableState} */ (value);
            return { ...state, val: this.coerceScalarValue(id, state.val) };
        }
        return this.coerceScalarValue(id, value);
    }

    /**
     * Writes an acknowledged value that came from the DSS, converted to the declared type.
     *
     * @param {string} id
     * @param {unknown} value
     */
    setDssState(id, value) {
        if (!id) {
            return;
        }
        const converted = this.coerceStateValue(id, value);
        if (converted === undefined) {
            // Writing undefined would only produce a js-controller warning, same as in
            // DSSStructure.setStateSafe()
            return;
        }
        // Everything the dSS reports comes through here - that is what keeps the known
        // value of a user state current, see DSSStructure.noteUserStateValue()
        if (this.dssStruct && typeof this.dssStruct.noteUserStateValue === 'function') {
            this.dssStruct.noteUserStateValue(id, converted);
        }
        this.setState(id, converted, true);
    }

    eventLog(eventName, event, handled) {
        this.log.debug(`${handled ? '' : 'UNHANDLED '}EVENT: ${eventName}: ${JSON.stringify(event)}`);
    }

    registerObjects() {
        const dssStruct = this.dssStruct;
        if (!dssStruct) {
            return;
        }
        const objNames = Object.keys(dssStruct.dssObjects);
        this.log.info(`Create ${objNames.length} objects ...`);
        objNames.forEach(id => {
            const obj = dssStruct.dssObjects[id];
            // The DSS delivers e.g. state values as strings - the object is created with its
            // declared type right away, so the initial value has to match it.
            const initValue = this.coerceStateValue(id, obj.value);
            const onChange = obj.onChange;
            delete obj.value;
            delete obj.onChange;

            this.objectHelper.setOrUpdateObject(id, obj, ['name'], initValue, onChange);
        });
    }

    setInitialValues(callback, list) {
        const dssStruct = this.dssStruct;
        if (!dssStruct) {
            return void (callback && callback());
        }
        if (list === undefined) {
            list = Object.keys(dssStruct.initialObjectValues);
        }
        if (list && !list.length) {
            return callback && callback();
        }
        const id = list.shift();
        const value = dssStruct.initialObjectValues[id];
        if (value === undefined) {
            // undefined values would only produce js-controller warnings
            return void setImmediate(() => this.setInitialValues(callback, list));
        }
        const converted = this.coerceStateValue(id, value);
        if (converted === undefined) {
            return void setImmediate(() => this.setInitialValues(callback, list));
        }
        this.setState(id, converted, true, () => this.setInitialValues(callback, list));
    }

    clearAdditionalObjects(delIds, callback) {
        if (typeof delIds === 'function') {
            callback = delIds;
            delIds = null;
        }
        if (!delIds && this.objectHelper.existingStates) {
            delIds = Object.keys(this.objectHelper.existingStates);
            if (delIds.length) {
                // Normalized again right at the destructive branch: only an unambiguously
                // true value may delete objects, whatever the configuration contains.
                if (!configUtils.normalizeBoolean(this.config.deleteUnknownObjects, false)) {
                    // Devices that are temporarily absent (offline circuit, unreachable device)
                    // would lose their objects including all custom settings (history, influxdb, ...).
                    // So only report them and let the user decide via the config option.
                    this.log.info(
                        `The following objects are unknown to the current DSS structure and would be deleted if "Delete unknown objects" is enabled in the adapter settings: ${JSON.stringify(
                            delIds,
                        )}`,
                    );
                    return void (callback && callback());
                }
                this.log.info(`Deleting the following states: ${JSON.stringify(delIds)}`);
            }
        }
        if (!delIds || !delIds.length) {
            return void (callback && callback());
        }
        const del = delIds.shift();
        this.delObject(del, err => {
            if (err) {
                this.log.info(` Could not delete ${del}: ${err}`);
            }
            if (this.objectHelper.existingStates) {
                delete this.objectHelper.existingStates[del];
            }
            setImmediate(() => this.clearAdditionalObjects(delIds, callback));
        });
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<import('@iobroker/adapter-core').AdapterOptions>} [options]
     */
    module.exports = options => new Digitalstrom(options);
    // Additionally exposed for unit tests - js-controller only uses the function itself
    module.exports.Digitalstrom = Digitalstrom;
} else {
    // otherwise start the instance directly
    new Digitalstrom();
}
