const { expect } = require('chai');

const SmartHomeOutputSync = require('../lib/dssSmartHomeSync');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The sync needs very little of the structure - exactly this surface.
 *
 * @returns {any}
 */
function createFakeStructure() {
    const written = [];
    const classicReads = [];
    const warnings = [];
    return {
        written,
        classicReads,
        warnings,
        initialObjectValues: {},
        isAdapterStopping: () => false,
        setClearableTimeout: (func, ms) => setTimeout(func, ms),
        setStateSafe(id, value) {
            written.push({ id, value });
        },
        queueClassicOutputRead(dev, outputType, prio) {
            classicReads.push({ dSUID: dev.dSUID, outputType, prio });
        },
        adapterLog: {
            silly: () => {},
            debug: () => {},
            info: () => {},
            warn: message => warnings.push(message),
            error: () => {},
        },
    };
}

/**
 * @param {any} structure
 * @param {any} smartHome
 * @param {object} [options]
 * @returns {SmartHomeOutputSync}
 */
function createSync(structure, smartHome, options) {
    return new SmartHomeOutputSync({
        structure,
        smartHome,
        adapter: { log: structure.adapterLog },
        debounce: 30,
        followUpDelay: 40,
        maxFollowUps: 2,
        failureBackoff: 60 * 1000,
        ...options,
    });
}

/**
 * @param {string} dSUID
 * @param {Record<string, number|undefined>} outputs output id to value; undefined = no value field
 * @returns {any} one dsDeviceStatus entry
 */
function statusDevice(dSUID, outputs) {
    return {
        id: dSUID,
        type: 'dsDeviceStatus',
        attributes: {
            functionBlocks: [
                {
                    id: dSUID,
                    outputs: Object.entries(outputs).map(([id, value]) =>
                        value === undefined ? { id, status: 'moving' } : { id, value, status: 'ok' },
                    ),
                },
            ],
        },
    };
}

const SHADE = () => ({
    dSUID: 'shade1',
    outputChannelList: {
        shadePositionOutside: 'devices.m1.shade1.shadePositionOutside',
        shadeOpeningAngleOutside: 'devices.m1.shade1.shadeOpeningAngleOutside',
    },
});

describe('Smart Home output sync', function () {
    this.timeout(10000);

    it('collects several devices into one status request and writes rounded values', async () => {
        const structure = createFakeStructure();
        let statusCalls = 0;
        const sync = createSync(structure, {
            getApartmentStatus: async () => {
                statusCalls++;
                return {
                    included: {
                        dsDevices: [
                            statusDevice('shade1', { shadePositionOutside: 32.004272526131075 }),
                            statusDevice('light1', { brightness: 79.2156862745098 }),
                        ],
                    },
                };
            },
        });

        const lightValues = [];
        const light = {
            dSUID: 'light1',
            outputChannelList: { brightness: 'devices.m1.light1.brightness' },
            applyNativeLightValue: value => lightValues.push(value),
        };
        const shade = SHADE();
        expect(sync.requestDeviceSync(shade, ['shadePositionOutside'])).to.equal(true);
        expect(sync.requestDeviceSync(light, ['brightness'])).to.equal(true);
        await delay(100);

        expect(statusCalls, 'both devices share one request').to.equal(1);
        expect(structure.written).to.deep.equal([{ id: 'devices.m1.shade1.shadePositionOutside', value: 32 }]);
        expect(structure.initialObjectValues['devices.m1.shade1.shadePositionOutside']).to.equal(32);
        // 79.2156862745098 % are exactly 202 in the native 0..255 scale of the light
        // helper, which also maintains the boolean .state of the light
        expect(lightValues).to.deep.equal([202]);
        expect(structure.classicReads).to.have.lengthOf(0);
    });

    // Waehrend ein Rollladen faehrt, fehlt das value-Feld im Status. Fehlend heisst
    // "unveraendert lassen" - niemals null schreiben, und spaeter noch einmal nachsehen.
    it('leaves a moving output untouched and picks it up with a follow-up', async () => {
        const structure = createFakeStructure();
        let statusCalls = 0;
        const sync = createSync(structure, {
            getApartmentStatus: async () => {
                statusCalls++;
                return {
                    included: {
                        dsDevices: [
                            statusDevice('shade1', {
                                shadePositionOutside: statusCalls === 1 ? undefined : 64.5,
                            }),
                        ],
                    },
                };
            },
        });

        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        await delay(35);
        expect(structure.written, 'no value while the blind moves').to.have.lengthOf(0);

        await delay(60);
        expect(statusCalls, 'a follow-up asked again').to.equal(2);
        expect(structure.written).to.deep.equal([{ id: 'devices.m1.shade1.shadePositionOutside', value: 65 }]);
        expect(structure.classicReads).to.have.lengthOf(0);
    });

    it('falls back to the classic read once the follow-ups are exhausted', async () => {
        const structure = createFakeStructure();
        const sync = createSync(structure, {
            // The output never carries a value
            getApartmentStatus: async () => ({
                included: { dsDevices: [statusDevice('shade1', { shadePositionOutside: undefined })] },
            }),
        });

        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        await delay(250);

        expect(structure.classicReads).to.deep.equal([
            { dSUID: 'shade1', outputType: 'shadePositionOutside', prio: 'medium' },
        ]);
        expect(structure.written).to.have.lengthOf(0);
    });

    it('falls back immediately and pauses itself when the status request fails', async () => {
        const structure = createFakeStructure();
        const sync = createSync(structure, {
            getApartmentStatus: async () => {
                throw new Error('connection refused');
            },
        });

        const shade = SHADE();
        sync.requestDeviceSync(shade, ['shadePositionOutside', 'shadeOpeningAngleOutside']);
        await delay(60);

        expect(structure.classicReads.map(read => read.outputType).sort()).to.deep.equal([
            'shadeOpeningAngleOutside',
            'shadePositionOutside',
        ]);
        expect(structure.warnings, 'the fallback is said once').to.have.lengthOf(1);
        expect(structure.warnings[0]).to.contain('classic API');
        // During the backoff every new trigger goes classic right away
        expect(sync.isAvailable()).to.equal(false);
        expect(sync.requestDeviceSync(shade, ['shadePositionOutside'])).to.equal(false);
    });

    // Boolean-Kanaele (airLouverAuto & Co) sind gegen die neue API nicht verifiziert.
    // Der Sync reicht sie an queueClassicOutputRead durch - ob dort wirklich ein Request
    // entsteht, entscheidet der channelIndex des Kanals (heute: nein, debug-Skip). Wichtig
    // ist, dass NIE ein geratener Wert geschrieben wird.
    it('hands boolean channels to the classic read instead of guessing', async () => {
        const structure = createFakeStructure();
        const sync = createSync(structure, {
            getApartmentStatus: async () => ({
                included: { dsDevices: [statusDevice('vent1', { airLouverAuto: 1 })] },
            }),
        });

        sync.requestDeviceSync(
            { dSUID: 'vent1', outputChannelList: { airLouverAuto: 'devices.m1.vent1.airLouverAuto' } },
            ['airLouverAuto'],
        );
        await delay(60);

        expect(structure.written).to.have.lengthOf(0);
        expect(structure.classicReads).to.deep.equal([{ dSUID: 'vent1', outputType: 'airLouverAuto', prio: 'medium' }]);
    });

    it('treats a device the status does not know like a moving output', async () => {
        const structure = createFakeStructure();
        const sync = createSync(structure, {
            getApartmentStatus: async () => ({ included: { dsDevices: [] } }),
        });

        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        await delay(250);

        // Never applied, so after the follow-ups the classic read has the last word
        expect(structure.classicReads).to.deep.equal([
            { dSUID: 'shade1', outputType: 'shadePositionOutside', prio: 'medium' },
        ]);
    });

    // Ein Trigger, der eintrifft, waehrend die Statusabfrage schon unterwegs ist, darf
    // nicht mit deren Antwort bedient werden - die zeigt den Stand von DAVOR
    it('does not satisfy a trigger with an answer that was already on its way', async () => {
        const structure = createFakeStructure();
        let statusCalls = 0;
        /** @type {(value: any) => void} */
        let resolveFirst = () => {};
        const sync = createSync(structure, {
            getApartmentStatus: () => {
                statusCalls++;
                if (statusCalls === 1) {
                    return new Promise(resolve => (resolveFirst = resolve));
                }
                return Promise.resolve({
                    included: { dsDevices: [statusDevice('shade1', { shadePositionOutside: 55 })] },
                });
            },
        });

        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        await delay(40);
        expect(statusCalls, 'the first read is on its way').to.equal(1);
        // The blind starts moving AGAIN while the answer is in flight
        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        // ... and the in-flight answer carries the position from before that move
        resolveFirst({ included: { dsDevices: [statusDevice('shade1', { shadePositionOutside: 10 })] } });
        await delay(80);

        expect(statusCalls, 'a second read serves the second trigger').to.equal(2);
        expect(
            structure.written.map(write => write.value),
            'the stale 10 must never be written',
        ).to.deep.equal([55]);
    });

    it('pulls a far follow-up timer forward for a fresh trigger', async () => {
        const structure = createFakeStructure();
        let statusCalls = 0;
        const sync = createSync(
            structure,
            {
                getApartmentStatus: async () => {
                    statusCalls++;
                    return {
                        included: {
                            dsDevices: [
                                // The blind never answers, the light always does
                                statusDevice('shade1', { shadePositionOutside: undefined }),
                                statusDevice('light1', { brightness: 50 }),
                            ],
                        },
                    };
                },
            },
            { followUpDelay: 5000 },
        );

        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        await delay(40);
        expect(statusCalls).to.equal(1);
        // The follow-up timer is armed for 5 s - the light must not wait for it
        const lightValues = [];
        sync.requestDeviceSync(
            {
                dSUID: 'light1',
                outputChannelList: { brightness: 'devices.m1.light1.brightness' },
                applyNativeLightValue: value => lightValues.push(value),
            },
            ['brightness'],
        );
        await delay(60);
        expect(statusCalls, 'the fresh trigger pulled the read forward').to.equal(2);
        expect(lightValues).to.deep.equal([Math.round(50 * 2.55)]);
    });

    it('does nothing after stop()', async () => {
        const structure = createFakeStructure();
        let statusCalls = 0;
        const sync = createSync(structure, {
            getApartmentStatus: async () => {
                statusCalls++;
                return { included: { dsDevices: [] } };
            },
        });
        sync.requestDeviceSync(SHADE(), ['shadePositionOutside']);
        sync.stop();
        await delay(80);
        expect(statusCalls).to.equal(0);
        expect(structure.classicReads).to.have.lengthOf(0);
    });
});
