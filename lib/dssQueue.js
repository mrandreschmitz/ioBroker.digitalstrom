const { errorMessage, asError } = require('./configUtils');

/**
 * @typedef {import('./configUtils').AdapterError} AdapterError
 */

// Params that carry the payload of a write request. They are excluded from the
// coalescing key so that a newer write to the same target can replace a pending older one.
const VALUE_PARAMS = ['value', 'sensorValue'];

class SupersededError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = 'SupersededError';
        // Consumers use this flag to skip error logging - being replaced by a newer
        // value is normal for fast slider/dimmer movements and not a failure.
        /** @type {boolean} */
        this.superseded = true;
    }
}

class DSSQueue {
    constructor(options) {
        this.options = options || {
            logger: console,
        };
        this.options.prioTimeouts = this.options.prioTimeouts || {
            high: 500,
            medium: 10000,
            low: 20000,
        };
        this.dss = options.dss;

        this.queryQueue = {};
        this.nextEntryTimeout = {};
        this.lastProcessed = {};
        this.queryRunning = {};
        // Once stopped no new entry is accepted and no new timer is created
        this.stopped = false;
    }

    /**
     * Stops the queue for good. Idempotent.
     *
     * Without this an ongoing state change during the unload could push a new entry after
     * clearQueues(), which would create a fresh timer and send a request to an already
     * closed DSS client.
     */
    stop() {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.clearQueues();
    }

    /**
     * Central classification of queue errors that belong to the normal operation and
     * therefore must never be reported as a warning to the user:
     * - `superseded`: a queued but not yet sent value was replaced by a newer one
     *   (last-write-wins coalescing, normal for sliders and dimmers)
     * - `shutdown`: the request was cancelled because the adapter is stopping
     *
     * Real network, DSS and response errors are deliberately NOT covered here.
     *
     * @param {unknown} err error handed to a queue callback
     * @returns {boolean} true if the error is expected and only worth a debug line
     */
    static isExpectedQueueError(err) {
        const error = asError(err);
        return !!error && (error.superseded === true || error.shutdown === true);
    }

    /**
     * Builds a canonical, collision free key for a request.
     * Uses nullish handling so that a valid 0 is not lost.
     *
     * @param {object} entry request entry with dssClass, dssFunction and params
     * @param {boolean} [ignoreValues] exclude payload params (used for the coalescing key)
     * @returns {string} canonical key
     */
    static createRequestKey(entry, ignoreValues) {
        const params = entry.params || {};
        const parts = Object.keys(params)
            .filter(name => !(ignoreValues && VALUE_PARAMS.includes(name)))
            .sort()
            .map(name => `${name}=${params[name] === undefined ? '' : String(params[name])}`);
        return `${entry.dssClass}/${entry.dssFunction}?${parts.join('&')}`;
    }

    clearQueue(circuit) {
        if (this.nextEntryTimeout[circuit]) {
            clearTimeout(this.nextEntryTimeout[circuit]);
            this.nextEntryTimeout[circuit] = null;
        }

        const pending = this.queryQueue[circuit] || [];
        this.queryQueue[circuit] = [];
        this.lastProcessed[circuit] = 0;
        pending.forEach(entry => {
            /** @type {AdapterError} */
            const err = new Error('Queue cleared');
            // The queue is only cleared when the adapter stops - an expected error, not a failure
            err.shutdown = true;
            this.runCallbacks(entry, err);
        });
    }

    clearQueues() {
        Object.keys(this.queryQueue).forEach(circuit => this.clearQueue(circuit));
    }

    /**
     * Invokes all callbacks of a queue entry exactly once, isolated from each other.
     * A throwing callback must never stop the remaining callbacks or the queue.
     *
     * @param {object} queueEntry
     * @param {Error|null} err
     * @param {object} [res]
     */
    runCallbacks(queueEntry, err, res) {
        const callbacks = queueEntry.callbacks;
        queueEntry.callbacks = null; // prevent a second invocation (e.g. clearQueue while in-flight)
        if (!callbacks) {
            return;
        }
        callbacks.forEach(callback => {
            if (!callback) {
                return;
            }
            try {
                callback(err, res);
            } catch (callbackErr) {
                const callbackError = asError(callbackErr);
                this.options.logger &&
                    this.options.logger.error(
                        `Error in queue callback for ${queueEntry.entryId}: ${
                            (callbackError && callbackError.stack) || errorMessage(callbackErr)
                        }`,
                    );
            }
        });
    }

    findNextPrioEntry(circuit, prio) {
        prio = prio || 'high';

        const found = this.queryQueue[circuit].findIndex(entry => entry.prio === prio && !entry.inFlight);
        if (found === -1) {
            switch (prio) {
                case 'high':
                    prio = 'medium';
                    break;
                case 'medium':
                    prio = 'low';
                    break;
                case 'low':
                    prio = null;
                    break;
            }
            if (prio) {
                return this.findNextPrioEntry(circuit, prio);
            }
            return -1;
        }
        return found;
    }

    pushQueryQueue(circuit, entryId, entry, prio, callback) {
        if (typeof entryId !== 'string') {
            callback = prio;
            prio = entry;
            entry = entryId;
            entryId = DSSQueue.createRequestKey(entry, true);
        }
        prio = prio || 'low';
        if (this.stopped) {
            // Reject in a controlled way instead of silently dropping the caller
            /** @type {AdapterError} */
            const err = new Error('Queue is stopped');
            err.shutdown = true;
            this.options.logger &&
                this.options.logger.debug(`Queue is stopped, rejecting new entry ${entryId} for ${circuit}`);
            callback && setImmediate(() => callback(err));
            return;
        }
        this.queryQueue[circuit] = this.queryQueue[circuit] || [];
        this.lastProcessed[circuit] = this.lastProcessed[circuit] || 0;

        const paramsKey = DSSQueue.createRequestKey(entry);
        // Only entries that are not sent yet may be merged or replaced
        const found = this.queryQueue[circuit].findIndex(item => item.entryId === entryId && !item.inFlight);

        if (found !== -1) {
            const existing = this.queryQueue[circuit][found];
            if (existing.paramsKey === paramsKey) {
                // Identical request (e.g. the same read): just listen to the same result
                if ((prio === 'high' && existing.prio !== 'high') || (prio === 'medium' && existing.prio === 'low')) {
                    existing.prio = prio;
                }
                existing.callbacks = existing.callbacks || [];
                existing.callbacks.push(callback);
                this.scheduleNext(circuit, entryId);
                return;
            }
            // Same target but a different payload: the newer value wins, the older one was never sent
            this.options.logger &&
                this.options.logger.debug(`Superseding queued entry ${entryId} for ${circuit} with a newer value`);
            // The entry is updated atomically BEFORE the old callbacks run. A superseded
            // callback may synchronously enqueue an even newer value for the same target
            // (typical for a slider that keeps moving) - running the callbacks first would
            // let this older call overwrite that newer request again and lose it.
            const supersededCallbacks = existing.callbacks;
            existing.entry = entry;
            existing.paramsKey = paramsKey;
            existing.callbacks = [callback];
            if ((prio === 'high' && existing.prio !== 'high') || (prio === 'medium' && existing.prio === 'low')) {
                existing.prio = prio;
            }
            this.scheduleNext(circuit, entryId);
            this.runCallbacks(
                { entryId, callbacks: supersededCallbacks },
                new SupersededError(`Request ${entryId} was superseded by a newer value`),
            );
            return;
        }

        this.queryQueue[circuit].push({
            prio,
            entryId,
            paramsKey,
            entry,
            inFlight: false,
            callbacks: [callback],
        });
        this.scheduleNext(circuit, entryId);
    }

    /**
     * Plans processing of the next queue entry. Only one timer per circuit exists.
     *
     * @param {string} circuit
     * @param {string} [entryId] only used for logging
     */
    scheduleNext(circuit, entryId) {
        const nextProcessIndex = this.findNextPrioEntry(circuit);
        if (this.nextEntryTimeout[circuit]) {
            clearTimeout(this.nextEntryTimeout[circuit]);
            this.nextEntryTimeout[circuit] = null;
        }
        // No new timer once the queue is stopped - it would outlive the unload
        if (nextProcessIndex === -1 || this.stopped) {
            return;
        }
        const prio = this.queryQueue[circuit][nextProcessIndex].prio;
        const sinceLastProcessed = Date.now() - this.lastProcessed[circuit];
        let nextEntryTimeout = this.options.prioTimeouts[prio];
        if (sinceLastProcessed < nextEntryTimeout) {
            nextEntryTimeout = nextEntryTimeout - sinceLastProcessed;
        } else {
            nextEntryTimeout = this.options.prioTimeouts.high;
        }
        this.options.logger &&
            this.options.logger.debug(
                `${Date.now()} Plan next queue entry (${entryId || ''}) for ${circuit} and prio ${prio} in ${nextEntryTimeout}ms`,
            );
        this.nextEntryTimeout[circuit] = setTimeout(() => {
            this.nextEntryTimeout[circuit] = null;
            this.processQueryQueue(circuit);
        }, nextEntryTimeout);
    }

    processQueryQueue(circuit) {
        if (this.stopped) {
            return;
        }
        const toProcess = this.findNextPrioEntry(circuit);
        if (toProcess === -1 || this.queryRunning[circuit]) {
            return;
        }

        const query = this.queryQueue[circuit][toProcess];
        this.options.logger &&
            this.options.logger.debug(
                `${Date.now()} PROCESS Queued entry ${query.entry.dssClass}/${query.entry.dssFunction} and ${JSON.stringify(query.entry.params)}`,
            );
        this.queryRunning[circuit] = true;
        query.inFlight = true;

        // Bookkeeping and planning of the next entry must happen in any case - even if a
        // callback throws - otherwise the queue of this circuit would stall forever.
        const finish = (err, res) => {
            this.queryRunning[circuit] = false;
            this.lastProcessed[circuit] = Date.now();
            query.inFlight = false;
            const index = this.queryQueue[circuit].indexOf(query);
            if (index !== -1) {
                this.queryQueue[circuit].splice(index, 1);
            }
            try {
                this.runCallbacks(query, err, res);
            } finally {
                this.scheduleNext(circuit, query.entryId);
            }
        };

        this.dss.requestAsync(query.entry.dssClass, query.entry.dssFunction, query.entry.params).then(
            res => {
                this.options.logger &&
                    this.options.logger.debug(
                        `${Date.now()} Queued entry processed ${query.entry.dssClass}/${query.entry.dssFunction}`,
                    );
                finish(null, res);
            },
            err => {
                // Expected errors stay debug: adapter stop, superseded write, best effort read
                const level = DSSQueue.isExpectedQueueError(err) || query.entry.quiet ? 'debug' : 'warn';
                this.options.logger &&
                    this.options.logger[level](
                        `Queued entry ERROR ${query.entry.dssClass}/${query.entry.dssFunction} and ${JSON.stringify(
                            query.entry.params,
                        )}: ${(err && err.message) || JSON.stringify(err)}`,
                    );
                finish(err);
            },
        );
    }

    queueUpdateOutputValue(dev, index, length, prio, callback) {
        if (typeof length === 'string') {
            callback = prio;
            prio = length;
            length = 1;
        }
        if (typeof prio === 'function') {
            callback = prio;
            prio = null;
        }
        if (length > 4) {
            if (length === 255) {
                length = 1;
            } else if (length === 65535) {
                length = 2;
            }
        }
        const callEntry = {
            dssClass: 'device',
            dssFunction: 'getOutputValue',
            params: {
                dsuid: dev.dSUID,
                offset: index,
                category: 'manual',
            },
            // Reading an output value is best effort: not every device answers for every
            // channel (a blind without tilt returns HTTP 500 for the angle parameter).
            // The caller reports it once, so the queue must not warn on every repetition.
            quiet: true,
        };

        if (length === 2 || index > 0) {
            callEntry.dssFunction = length === 2 ? 'getConfigWord' : 'getConfig';
            callEntry.params.class = 64;
            callEntry.params.index = callEntry.params.offset;
            delete callEntry.params.offset;
        }
        this.pushQueryQueue(dev.meterDSUID, callEntry, prio, (err, res) => {
            if (err) {
                callback && callback(err);
            } else if (res && (res.ok === false || !res.result)) {
                callback && callback(res.message || res.status_code || res);
            } else {
                callback && callback(null, res.result.value);
            }
        });
    }

    queueSetOutputValue(dev, index, length, value, prio, callback) {
        if (typeof value === 'string') {
            // Legacy signature (dev, index, value, prio, callback) - shift arguments,
            // otherwise the priority string would be sent to the DSS as output value.
            callback = prio;
            prio = value;
            value = length;
            length = 1;
        }
        if (typeof prio === 'function') {
            callback = prio;
            prio = null;
        }
        if (length > 4) {
            if (length === 255) {
                length = 1;
            } else if (length === 65535) {
                length = 2;
            }
        }
        const callEntry = {
            dssClass: 'device',
            dssFunction: 'setValue',
            params: {
                dsuid: dev.dSUID,
                offset: index,
                value,
                category: 'manual',
            },
        };

        // brigthness length = 1 index = 0 --> setValue
        // rolladen shade pos length = 2, index =2 -> setOutputValue
        // rollladen shade tilt length = 1, index = 4 -> setConfig

        if (length === 2 && index === 2) {
            callEntry.dssFunction = 'setOutputValue';
        } else if (index !== 0) {
            callEntry.dssFunction = 'setConfig';
            callEntry.params.class = 64;
            callEntry.params.index = callEntry.params.offset;
            delete callEntry.params.offset;
        }
        if (callEntry.dssFunction === 'setValue' && callEntry.params.offset !== undefined) {
            delete callEntry.params.offset;
        }
        this.pushQueryQueue(dev.meterDSUID, callEntry, prio, (err, res) => {
            if (err) {
                callback && callback(err);
            } else if (res && res.ok === false) {
                callback && callback(res.message || res.status_code || res);
            } else {
                callback && callback(null, value);
            }
        });
    }
}

module.exports = DSSQueue;
module.exports.SupersededError = SupersededError;
