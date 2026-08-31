const dssConstants = require('./constants');
const { errorMessage } = require('./configUtils');

/**
 * Reads device output values through the Smart Home API - ONE apartment status request
 * instead of one classic request per output channel.
 *
 * The status delivers every output of every device in a single answer (~59 KB), in
 * exactly the scale the ioBroker states use: the new API normalizes each channel to its
 * official value range (brightness 0..100, colortemp 0..1000, ...), which is precisely
 * `classic * max / nativeMax` - the conversion the classic read path applies by hand.
 * Verified against a dSS20 1.19.13, see docs/smarthome-api.md.
 *
 * Two rules from the live measurements shape this class:
 *
 * 1. A moving output carries NO value in the status (the field is simply absent while a
 *    blind travels). A missing value therefore means "unchanged", never null - the
 *    channel stays pending and is asked again with the next follow-up.
 * 2. Requests are coalesced: a room scene touches many devices at once, and one status
 *    answer covers them all. The window is fixed (not sliding), so a steady stream of
 *    scene calls cannot delay the read forever.
 *
 * Every channel the status cannot deliver falls back to the classic read path, so with
 * the Smart Home API switched off or failing the behaviour is exactly the one before.
 */

/** Collect triggers for this long before the one status request */
const DEFAULT_DEBOUNCE = 2000;
/** A travelling blind carries no value - ask again after this pause */
const DEFAULT_FOLLOW_UP_DELAY = 15000;
/** After this many follow-ups the classic read takes over */
const DEFAULT_MAX_FOLLOW_UPS = 4;
/** After a failed status request the classic path serves alone for this long */
const DEFAULT_FAILURE_BACKOFF = 5 * 60 * 1000;

class SmartHomeOutputSync {
    /**
     * @param {object} options
     * @param {object} options.structure the DSSStructure instance
     * @param {object} options.smartHome the DSSSmartHome client
     * @param {object} options.adapter
     * @param {number} [options.debounce]
     * @param {number} [options.followUpDelay]
     * @param {number} [options.maxFollowUps]
     * @param {number} [options.failureBackoff]
     */
    constructor(options) {
        this.structure = options.structure;
        this.smartHome = options.smartHome;
        this.adapter = options.adapter;
        this.debounce = options.debounce || DEFAULT_DEBOUNCE;
        this.followUpDelay = options.followUpDelay || DEFAULT_FOLLOW_UP_DELAY;
        this.maxFollowUps = options.maxFollowUps === undefined ? DEFAULT_MAX_FOLLOW_UPS : options.maxFollowUps;
        this.failureBackoff = options.failureBackoff || DEFAULT_FAILURE_BACKOFF;

        /** @type {Map<string, {dev: any, outputTypes: Set<string>, attempts: number, lastTriggeredAt: number}>} */
        this.pending = new Map();
        this.flushTimer = null;
        /** When the armed flush timer will fire - to let an earlier request pull it forward */
        this.flushTimerFireAt = 0;
        /** True while a status request is on its way */
        this.flushInFlight = false;
        this.disabledUntil = 0;
        this.warnedFailure = false;
    }

    /** @returns {number} */
    now() {
        return Date.now();
    }

    /**
     * @returns {boolean} false while a failed request keeps the classic path in charge
     */
    isAvailable() {
        return !!this.smartHome && this.disabledUntil <= this.now();
    }

    /**
     * Asks for a fresh read of the given output channels of a device.
     *
     * @param {object} dev device object of the structure, with outputChannelList
     * @param {string[]} [outputTypes] channel types, default every channel of the device
     * @returns {boolean} true when the sync takes care of it, false = use the classic path
     */
    requestDeviceSync(dev, outputTypes) {
        if (!dev || !dev.dSUID || !dev.outputChannelList || !this.isAvailable()) {
            return false;
        }
        const wanted =
            outputTypes && outputTypes.length
                ? outputTypes.filter(type => dev.outputChannelList[type])
                : Object.keys(dev.outputChannelList);
        if (!wanted.length) {
            return false;
        }
        const entry = this.pending.get(dev.dSUID) || { dev, outputTypes: new Set(), attempts: 0, lastTriggeredAt: 0 };
        wanted.forEach(type => entry.outputTypes.add(type));
        // A new trigger restarts the follow-up budget - the outputs are moving again.
        // The timestamp keeps a status answer that was already on its way from
        // satisfying this trigger with values from before it.
        entry.attempts = 0;
        entry.lastTriggeredAt = this.now();
        this.pending.set(dev.dSUID, entry);
        this.scheduleFlush(this.debounce);
        return true;
    }

    /**
     * @param {number} delay ms until the pending devices are read
     */
    scheduleFlush(delay) {
        const fireAt = this.now() + delay;
        if (this.flushTimer) {
            if (fireAt >= this.flushTimerFireAt) {
                // The armed timer fires earlier or at the same time - join that read
                return;
            }
            // A fresh 2 s trigger must not wait behind a 15 s follow-up timer
            clearTimeout(this.flushTimer);
            this.structure.pendingTimeouts && this.structure.pendingTimeouts.delete(this.flushTimer);
            this.flushTimer = null;
        }
        this.flushTimerFireAt = fireAt;
        this.flushTimer = this.structure.setClearableTimeout(() => {
            this.flushTimer = null;
            this.flush().catch(err => {
                // flush() handles its own errors, this only guards a broken handler
                this.adapter.log.error(`Smart Home output sync failed unexpectedly: ${errorMessage(err)}`);
            });
        }, delay);
    }

    /**
     * ONE status request for everything that piled up, then classic reads for the rest.
     */
    async flush() {
        if (this.structure.isAdapterStopping() || !this.pending.size) {
            return;
        }
        if (!this.isAvailable()) {
            return void this.fallBackAll();
        }
        if (this.flushInFlight) {
            // The running read predates this timer - ask again once it is through
            return void this.scheduleFlush(this.debounce);
        }
        // A trigger that arrives while the request is on its way must not be satisfied
        // by its answer - the answer shows the state from BEFORE that trigger
        const flightStart = this.now();
        this.flushInFlight = true;
        let status;
        try {
            status = await this.smartHome.getApartmentStatus();
        } catch (err) {
            this.flushInFlight = false;
            const shutdown = !!(err && typeof err === 'object' && 'shutdown' in err && err.shutdown === true);
            if (shutdown || this.structure.isAdapterStopping()) {
                return;
            }
            this.disabledUntil = this.now() + this.failureBackoff;
            const minutes = Math.max(1, Math.round(this.failureBackoff / 60000));
            const message =
                `Could not read the output values via the Smart Home API (${errorMessage(err)}); ` +
                `reading them through the classic API and trying the Smart Home API again in ${minutes} minute${
                    minutes === 1 ? '' : 's'
                }`;
            if (this.warnedFailure) {
                this.adapter.log.debug(message);
            } else {
                this.adapter.log.warn(message);
                this.warnedFailure = true;
            }
            return void this.fallBackAll();
        }
        this.flushInFlight = false;
        if (this.structure.isAdapterStopping()) {
            return;
        }
        this.warnedFailure = false;
        this.applyStatus(status, flightStart);
        if (typeof this.structure.applyZoneTemperatureStatus === 'function') {
            // Die Antwort traegt auch Sollwert und Stellgroesse der Raumtemperatur-
            // regelung je Zone - mitnehmen, sie ist schon bezahlt
            this.structure.applyZoneTemperatureStatus(status);
        }

        // What is left had no value in the answer - typically a travelling blind.
        // Ask again a few times, then let the classic read deliver whatever it can.
        for (const [dSUID, entry] of [...this.pending]) {
            if (entry.lastTriggeredAt > flightStart) {
                // Was not asked yet - its own read is already scheduled
                continue;
            }
            entry.attempts++;
            if (entry.attempts > this.maxFollowUps) {
                this.pending.delete(dSUID);
                this.fallBackEntry(entry);
            }
        }
        if (this.pending.size) {
            const hasFreshTrigger = [...this.pending.values()].some(entry => entry.lastTriggeredAt > flightStart);
            this.scheduleFlush(hasFreshTrigger ? this.debounce : this.followUpDelay);
        }
    }

    /**
     * Writes every pending output value the status answer carries.
     *
     * @param {any} status answer of getApartmentStatus()
     * @param {number} flightStart entries triggered after this moment are not touched
     */
    applyStatus(status, flightStart) {
        const statusDevices = (status && status.included && status.included.dsDevices) || [];
        const devicesById = new Map();
        for (const device of statusDevices) {
            if (device && typeof device.id === 'string') {
                devicesById.set(device.id, device);
            }
        }
        let applied = 0;
        for (const [dSUID, entry] of [...this.pending]) {
            if (entry.lastTriggeredAt > flightStart) {
                // The answer predates this trigger and could carry stale values
                continue;
            }
            const values = SmartHomeOutputSync.collectOutputValues(devicesById.get(dSUID));
            for (const outputType of [...entry.outputTypes]) {
                const value = values.get(outputType);
                if (value === undefined) {
                    // Missing means "unchanged while it moves", never null - stays pending
                    continue;
                }
                if (this.applyValue(entry.dev, outputType, value) === 'unsupported') {
                    // The channel exists but its semantics are not verified against the
                    // new API (boolean 0/1 channels) - the classic read knows them
                    this.structure.queueClassicOutputRead(entry.dev, outputType, 'medium');
                } else {
                    applied++;
                }
                entry.outputTypes.delete(outputType);
            }
            if (!entry.outputTypes.size) {
                this.pending.delete(dSUID);
            }
        }
        if (applied && typeof this.structure.reportOutputApi === 'function') {
            // Makes the division of labour visible: info.outputApi in the instance
            this.structure.reportOutputApi('smarthome');
        }
    }

    /**
     * The outputs of a device status, across all its function blocks.
     *
     * @param {any} statusEntry one dsDeviceStatus entry
     * @returns {Map<string, number>} output id (= channel type) to value
     */
    static collectOutputValues(statusEntry) {
        const values = new Map();
        const blocks = (statusEntry && statusEntry.attributes && statusEntry.attributes.functionBlocks) || [];
        for (const block of blocks) {
            for (const output of (block && block.outputs) || []) {
                if (
                    output &&
                    typeof output.id === 'string' &&
                    typeof output.value === 'number' &&
                    isFinite(output.value)
                ) {
                    values.set(output.id, output.value);
                }
            }
        }
        return values;
    }

    /**
     * Writes one value the way the classic read callback would have written it.
     *
     * @param {any} dev
     * @param {string} outputType
     * @param {number} value already in the ioBroker scale of the channel
     * @returns {'applied'|'unsupported'}
     */
    applyValue(dev, outputType, value) {
        const roleDef = dssConstants.outputChannelUnitRoleMap[outputType];
        const stateId = dev.outputChannelList && dev.outputChannelList[outputType];
        if (!roleDef || !stateId) {
            return 'unsupported';
        }
        if (outputType === 'brightness' && typeof dev.applyNativeLightValue === 'function') {
            // The light helper also maintains the boolean .state (switch threshold!),
            // so the value goes back to the native 0..255 scale it expects
            dev.applyNativeLightValue(Math.round(value * 2.55));
            return 'applied';
        }
        if (roleDef.type === 'boolean') {
            return 'unsupported';
        }
        // The classic read callbacks round to whole numbers in the ioBroker scale
        const rounded = Math.round(value);
        this.structure.setStateSafe(stateId, rounded);
        this.structure.initialObjectValues[stateId] = rounded;
        return 'applied';
    }

    /**
     * Classic reads for everything that is still pending.
     */
    fallBackAll() {
        const entries = [...this.pending.values()];
        this.pending.clear();
        entries.forEach(entry => this.fallBackEntry(entry));
    }

    /**
     * @param {{dev: any, outputTypes: Set<string>}} entry
     */
    fallBackEntry(entry) {
        entry.outputTypes.forEach(outputType => this.structure.queueClassicOutputRead(entry.dev, outputType, 'medium'));
    }

    stop() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.pending.clear();
    }
}

module.exports = SmartHomeOutputSync;
