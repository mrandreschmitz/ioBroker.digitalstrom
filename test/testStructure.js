const EventEmitter = require('node:events');
const { expect } = require('chai');
const DSSStructure = require('../lib/dssStructure');
const DSSQueue = require('../lib/dssQueue');
const dssConstants = require('../lib/constants');

const silentLogger = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function createStructure(overrides) {
    return new DSSStructure(
        Object.assign(
            {
                dss: {},
                dssQueue: {},
                adapter: { log: silentLogger, config: {} },
            },
            overrides,
        ),
    );
}

describe('DSSStructure', () => {
    it('convertSceneName strips bracket suffixes and spaces', () => {
        const struct = createStructure();
        expect(struct.convertSceneName('Deep Off')).to.equal('DeepOff');
        expect(struct.convertSceneName('Preset 2 (Standard)')).to.equal('Preset2');
        expect(struct.convertSceneName('')).to.equal('');
    });

    it('convertObject maps arrays by the given name field', () => {
        const struct = createStructure();
        const res = struct.convertObject(
            [
                { id: 1, name: 'one' },
                { id: 2, name: 'two' },
            ],
            'id',
        );
        expect(res).to.have.property('1');
        expect(res[2].name).to.equal('two');
    });

    it('convertObject tolerates invalid input', () => {
        const struct = createStructure();
        expect(struct.convertObject(null, 'id')).to.deep.equal({});
        expect(struct.convertObject('nope', 'id')).to.deep.equal({});
        expect(struct.convertObject([{ noIdField: true }], 'id')).to.deep.equal({});
    });

    it('clearTimeouts cancels pending timeouts', done => {
        const struct = createStructure();
        let fired = false;
        struct.setClearableTimeout(() => {
            fired = true;
        }, 5);
        struct.clearTimeouts();
        expect(struct.pendingTimeouts.size).to.equal(0);
        setTimeout(() => {
            expect(fired).to.equal(false);
            done();
        }, 15);
    });

    it('updateMeterData reports failed and total request counts', done => {
        const struct = createStructure({
            dssQueue: {
                pushQueryQueue: (circuit, entryId, entry, prio, callback) => {
                    // getConsumption succeeds, getEnergyMeterValue fails
                    if (entryId === 'getConsumption') {
                        setImmediate(() => callback(null, { ok: true, result: { consumption: 42 } }));
                    } else {
                        setImmediate(() => callback(new Error('unreachable')));
                    }
                },
            },
            adapter: {
                log: silentLogger,
                config: {},
                setState: () => {},
            },
        });
        struct.apartmentCircuits = [
            { hasMetering: true, dSUID: 'meter1' },
            { hasMetering: false, dSUID: 'meter2' },
        ];
        struct.updateMeterData((failed, total) => {
            expect(total).to.equal(2);
            expect(failed).to.equal(1);
            done();
        });
    });
    describe('setStateSafe', () => {
        function writingStructure(written) {
            return createStructure({
                adapter: {
                    log: silentLogger,
                    config: {},
                    setState: () => {},
                    setDssState: (id, v) => written.push([id, v]),
                },
            });
        }

        it('parks values as initial values while the objects do not exist yet', () => {
            const written = [];
            const struct = writingStructure(written);
            struct.objectsReady = false;
            struct.setStateSafe('devices.m1.dev1.shadePositionOutside', 42);
            expect(written, 'must not write to a not yet existing object').to.deep.equal([]);
            expect(struct.initialObjectValues['devices.m1.dev1.shadePositionOutside']).to.equal(42);
        });

        it('writes via the type conversion once the objects are created', () => {
            const written = [];
            const struct = writingStructure(written);
            struct.objectsReady = true;
            struct.setStateSafe('devices.m1.dev1.shadePositionOutside', 42);
            expect(written).to.deep.equal([['devices.m1.dev1.shadePositionOutside', 42]]);
        });

        it('ignores undefined values', () => {
            const written = [];
            const struct = writingStructure(written);
            struct.objectsReady = true;
            struct.setStateSafe('devices.m1.dev1.x', undefined);
            expect(written).to.deep.equal([]);
            expect(struct.initialObjectValues).to.not.have.property('devices.m1.dev1.x');
        });
    });

    describe('logOutputReadError', () => {
        function loggingStructure(entries) {
            return createStructure({
                adapter: {
                    log: Object.assign({}, silentLogger, {
                        info: msg => entries.push(['info', String(msg)]),
                        debug: msg => entries.push(['debug', String(msg)]),
                        warn: msg => entries.push(['warn', String(msg)]),
                    }),
                    config: {},
                },
            });
        }
        const dev = { dSUID: 'dev1', name: 'Wohnen Rollladen' };

        it('reports a device that does not deliver a value exactly once', () => {
            const entries = [];
            const struct = loggingStructure(entries);
            const err = new Error('HTTP 500 for /json/device/getConfig');

            struct.logOutputReadError(dev, 'shadeOpeningAngleOutside', err);
            struct.logOutputReadError(dev, 'shadeOpeningAngleOutside', err);
            struct.logOutputReadError(dev, 'shadeOpeningAngleOutside', err);

            expect(
                entries.map(e => e[0]),
                'only the first one is visible',
            ).to.deep.equal(['info', 'debug', 'debug']);
            expect(entries[0][1]).to.contain('Wohnen Rollladen');
            expect(entries[0][1]).to.contain('shadeOpeningAngleOutside');
            expect(entries[0][1]).to.contain('HTTP 500');
            expect(
                entries.some(e => e[0] === 'warn'),
                'never a warning',
            ).to.equal(false);
        });

        it('keeps devices and channels apart', () => {
            const entries = [];
            const struct = loggingStructure(entries);
            const err = new Error('HTTP 500');
            struct.logOutputReadError(dev, 'shadeOpeningAngleOutside', err);
            struct.logOutputReadError(dev, 'shadePositionOutside', err);
            struct.logOutputReadError({ dSUID: 'dev2' }, 'shadeOpeningAngleOutside', err);
            expect(entries.map(e => e[0])).to.deep.equal(['info', 'info', 'info']);
        });

        it('falls back to the dSUID when the device has no name', () => {
            const entries = [];
            loggingStructure(entries).logOutputReadError({ dSUID: 'dev9' }, 'brightness', new Error('boom'));
            expect(entries[0][1]).to.contain('dev9');
        });
    });

    describe('logQueueError', () => {
        function loggingStructure(levels) {
            return createStructure({
                adapter: {
                    log: Object.assign({}, silentLogger, {
                        debug: () => levels.push('debug'),
                        warn: () => levels.push('warn'),
                    }),
                    config: {},
                },
            });
        }

        it('reports errors caused by the stop as debug', () => {
            const levels = [];
            /** @type {import('../lib/configUtils').AdapterError} */
            const err = new Error('Queue cleared');
            err.shutdown = true;
            loggingStructure(levels).logQueueError('Err getReachableScenes for zone 2 group 1', err);
            expect(levels).to.deep.equal(['debug']);
        });

        it('still warns about real errors', () => {
            const levels = [];
            loggingStructure(levels).logQueueError('Err getReachableScenes for zone 2 group 1', new Error('boom'));
            expect(levels).to.deep.equal(['warn']);
        });
    });

    describe('toBoolean', () => {
        it('maps the common DSS off words to false', () => {
            ['', '0', 'false', 'off', 'inactive', 'no', 'INACTIVE', ' Off '].forEach(v =>
                expect(DSSStructure.toBoolean(v), `${v} must be false`).to.equal(false),
            );
        });

        it('maps the common DSS on words to true', () => {
            ['1', 'true', 'on', 'active', 'yes'].forEach(v =>
                expect(DSSStructure.toBoolean(v), `${v} must be true`).to.equal(true),
            );
        });

        it('keeps non string values working', () => {
            expect(DSSStructure.toBoolean(0)).to.equal(false);
            expect(DSSStructure.toBoolean(1)).to.equal(true);
            expect(DSSStructure.toBoolean(null)).to.equal(false);
        });
    });

    describe('scene resolution', () => {
        it('resolves zone/room scenes that only exist in zoneSceneCommands', () => {
            const struct = createStructure();
            // 0, 5 and 17 are basic room scenes
            expect(struct.resolveSceneStateName(0)).to.equal('Preset0');
            expect(struct.resolveSceneStateName(5)).to.equal('Preset1');
            expect(struct.resolveSceneStateName(17)).to.equal('Preset2');
        });

        it('resolves apartment scenes', () => {
            const struct = createStructure();
            expect(struct.resolveSceneStateName(67)).to.equal('Standby');
            expect(struct.resolveSceneStateName(72)).to.equal('Absent');
        });

        it('returns null for an unknown scene instead of an undefined path', () => {
            const struct = createStructure();
            expect(struct.resolveSceneStateName(9999)).to.equal(null);
            expect(struct.resolveSceneStateName(undefined)).to.equal(null);
        });
    });

    describe('defensive handling of optional DSS data', () => {
        it('findStates survives missing property states', () => {
            const struct = createStructure();
            struct.propertyStates = undefined;
            expect(struct.findStates('^zone\\.1\\.(.*)$')).to.deep.equal([]);
            struct.propertyStates = [null, { noName: true }, { name: 'zone.1.heating' }];
            const res = struct.findStates('^zone\\.1\\.(.*)$');
            expect(res).to.have.lengthOf(1);
            expect(res[0].matchedName).to.equal('heating');
        });

        it('processZone tolerates a zone without sensor values and with temperature control', done => {
            const struct = createStructure({
                dssQueue: {
                    // answers every queued request, the last argument is always the callback
                    pushQueryQueue: (...args) => {
                        const callback = args[args.length - 1];
                        setImmediate(() => callback(null, { ok: true, result: { scene: 5 } }));
                    },
                },
                adapter: { log: silentLogger, config: {}, setState: () => {} },
            });
            struct.propertyStates = [];
            const zone = { id: 5, isPresent: true, isValid: true, name: 'Living', groups: [] };
            // sensorValues intentionally undefined, temperature control present
            struct.processZone('apartment.1', zone, [], undefined, { ControlMode: 1 }, err => {
                expect(err).to.equal(null);
                // the initial zone scene must be resolved via zoneSceneCommands
                expect(struct.initialObjectValues['apartment.1.5.scenes.sceneId']).to.equal(5);
                expect(struct.initialScenes['5.0']).to.equal(5);
                done();
            });
        });

        it('creates zone states with their declared type and the untouched DSS value', done => {
            const struct = createStructure({
                dssQueue: {
                    pushQueryQueue: (...args) => {
                        const callback = args[args.length - 1];
                        setImmediate(() => callback(null, { ok: true, result: { scene: 5 } }));
                    },
                },
                adapter: { log: silentLogger, config: {}, setState: () => {}, setDssState: () => {} },
            });
            // The DSS reports zone states as strings
            struct.propertyStates = [{ name: 'zone.5.heating', state: 'inactive' }];
            const zone = { id: 5, isPresent: true, isValid: true, name: 'Living', groups: [] };
            struct.processZone('apartment.1', zone, [], undefined, undefined, () => {
                const obj = struct.dssObjects['apartment.1.5.states.heating'];
                expect(obj.common.type, 'the object must stay boolean').to.equal('boolean');
                expect(obj.native).to.deep.equal({ valueTrue: 'active', valueFalse: 'inactive' });
                // Converted centrally when written, so the raw DSS value is kept here
                expect(obj.value).to.equal('inactive');
                expect(struct.initialObjectValues['apartment.1.5.states.heating']).to.equal('inactive');
                done();
            });
        });

        it('processZone skips a zone that is not part of the structure', done => {
            const struct = createStructure();
            struct.processZone('apartment.1', undefined, [], undefined, undefined, err => {
                expect(err).to.equal(null);
                done();
            });
        });
    });

    describe('shader devices and initializeOutputValues', () => {
        const POSITION_ID = 'devices.m1.dev1.shadePositionOutside';
        const ANGLE_ID = 'devices.m1.dev1.shadeOpeningAngleOutside';

        function shaderContext(initializeOutputValues) {
            const writes = [];
            const reads = [];
            const scenes = [];
            const struct = createStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    queueSetOutputValue: (dev, index, length, value, prio, callback) => {
                        writes.push({ index, length, value });
                        setImmediate(() => callback && callback(null, value));
                    },
                    queueUpdateOutputValue: (dev, index, length, prio, callback) => {
                        reads.push({ index, length });
                        setImmediate(() => callback && callback(null, 0));
                    },
                    pushQueryQueue: (circuit, entry, prio, callback) => {
                        scenes.push(entry.params.sceneNumber);
                        setImmediate(() => callback && callback(null, { ok: true }));
                    },
                },
                adapter: {
                    log: silentLogger,
                    config: { initializeOutputValues, usePresetValues: false },
                    setState: () => {},
                    setDssState: () => {},
                },
            });
            struct.objectsReady = true;
            struct.dssObjects[POSITION_ID] = { type: 'state', common: {}, native: {} };
            struct.dssObjects[ANGLE_ID] = { type: 'state', common: {}, native: {} };
            const dev = {
                dSUID: 'dev1',
                meterDSUID: 'meter1',
                name: 'Wohnen Rollladen',
                outputChannelList: {
                    shadePositionOutside: POSITION_ID,
                    shadeOpeningAngleOutside: ANGLE_ID,
                },
            };
            return { struct, dev, writes, reads, scenes };
        }

        // Regression: the write handlers used to be registered inside the
        // initializeOutputValues block, so switching that option off silently disabled
        // the whole blind control instead of only skipping the initial read.
        [true, false].forEach(initializeOutputValues => {
            it(`forwards a position write to the DSS with initializeOutputValues=${initializeOutputValues}`, done => {
                const { struct, dev, writes } = shaderContext(initializeOutputValues);
                struct.createShaderDevice(dev, 'devices.m1.dev1', () => {
                    expect(struct.dssObjects[POSITION_ID].onChange, 'a write handler must exist').to.be.a('function');
                    struct.dssObjects[POSITION_ID].onChange(50);
                    setTimeout(() => {
                        expect(writes, 'the position must reach the DSS').to.deep.equal([
                            { index: 2, length: 65535, value: Math.round((50 * 65535) / 100) },
                        ]);
                        done();
                    }, 10);
                });
            });

            it(`forwards an angle write to the DSS with initializeOutputValues=${initializeOutputValues}`, done => {
                const { struct, dev, writes } = shaderContext(initializeOutputValues);
                struct.createShaderDevice(dev, 'devices.m1.dev1', () => {
                    expect(struct.dssObjects[ANGLE_ID].onChange, 'a write handler must exist').to.be.a('function');
                    struct.dssObjects[ANGLE_ID].onChange(40);
                    setTimeout(() => {
                        expect(writes).to.deep.equal([{ index: 4, length: 255, value: Math.round((40 * 255) / 100) }]);
                        done();
                    }, 10);
                });
            });
        });

        it('uses the scene call for the end positions in both configurations', done => {
            const { struct, dev, scenes } = shaderContext(false);
            struct.createShaderDevice(dev, 'devices.m1.dev1', () => {
                struct.dssObjects[POSITION_ID].onChange(100);
                struct.dssObjects[POSITION_ID].onChange(0);
                setTimeout(() => {
                    expect(scenes, 'open = scene 14, close = scene 13').to.deep.equal([14, 13]);
                    done();
                }, 10);
            });
        });

        it('reads the initial values only when initializeOutputValues is on', done => {
            const on = shaderContext(true);
            on.struct.createShaderDevice(on.dev, 'devices.m1.dev1', () => {
                const off = shaderContext(false);
                off.struct.createShaderDevice(off.dev, 'devices.m1.dev1', () => {
                    setTimeout(() => {
                        expect(on.reads.length, 'position and angle are read').to.equal(2);
                        expect(off.reads, 'no read at all when switched off').to.deep.equal([]);
                        done();
                    }, 10);
                });
            });
        });

        it('reads after a scene event only when initializeOutputValues is on', done => {
            const on = shaderContext(true);
            on.struct.createShaderDevice(on.dev, 'devices.m1.dev1', () => {
                const off = shaderContext(false);
                off.struct.createShaderDevice(off.dev, 'devices.m1.dev1', () => {
                    on.reads.length = 0;
                    const event = { name: 'callScene', source: { isDevice: true }, properties: { sceneID: '17' } };
                    on.struct.dss.emit('dev1', event);
                    off.struct.dss.emit('dev1', event);
                    setTimeout(() => {
                        expect(on.reads.length, 'the real values are re-read').to.be.above(0);
                        expect(off.reads, 'no DSS read when switched off').to.deep.equal([]);
                        on.struct.clearTimeouts();
                        off.struct.clearTimeouts();
                        done();
                    }, 2100);
                });
            });
        }).timeout(6000);
    });

    describe('boolean output channels', () => {
        const STATE_ID = 'devices.meter1.dev1.airLouverAuto';

        function booleanChannelContext() {
            const writes = [];
            const struct = createStructure({
                dss: new EventEmitter(),
                dssQueue: {
                    queueSetOutputValue: (dev, index, length, value, prio, callback) => {
                        writes.push(value);
                        setImmediate(() => callback && callback(null, value));
                    },
                    queueUpdateOutputValue: (dev, index, length, prio, callback) =>
                        setImmediate(() => callback && callback(null, 0)),
                    pushQueryQueue: (circuit, entry, prio, callback) =>
                        setImmediate(() => callback && callback(null, { ok: true })),
                },
                adapter: {
                    log: Object.assign({}, silentLogger, { warn: msg => warnings.push(String(msg)) }),
                    config: { initializeOutputValues: false, usePresetValues: false },
                    setState: () => {},
                    setDssState: () => {},
                },
            });
            const warnings = [];
            struct.adapter.log.warn = msg => warnings.push(String(msg));
            struct.objectsReady = true;
            const dev = {
                dSUID: 'dev1',
                meterDSUID: 'meter1',
                zoneID: 5,
                name: 'Lueftung',
                hwInfo: 'BL-KM200',
                isValid: true,
                isPresent: true,
                outputMode: 1,
                outputChannels: [{ channelId: 'airLouverAuto', channelType: 'airLouverAuto', channelIndex: 20 }],
            };
            return { struct, dev, writes, warnings };
        }

        // Regression: the write handler only accepted numbers, so the two boolean
        // ventilation channels could not be switched at all.
        it('sends true as 1 and false as 0', done => {
            const { struct, dev, writes, warnings } = booleanChannelContext();
            struct.createDevice(dev, () => {
                struct.dssObjects[STATE_ID].onChange(true);
                struct.dssObjects[STATE_ID].onChange(false);
                setTimeout(() => {
                    expect(writes, 'the DSS representation of the boolean channel').to.deep.equal([1, 0]);
                    expect(warnings, 'a valid boolean must not warn').to.deep.equal([]);
                    done();
                }, 10);
            });
        });

        it('also accepts the string form the DSS and ioBroker use', done => {
            const { struct, dev, writes } = booleanChannelContext();
            struct.createDevice(dev, () => {
                struct.dssObjects[STATE_ID].onChange('true');
                struct.dssObjects[STATE_ID].onChange('off');
                setTimeout(() => {
                    expect(writes).to.deep.equal([1, 0]);
                    done();
                }, 10);
            });
        });

        it('still rejects an invalid type in a controlled way', done => {
            const { struct, dev, writes, warnings } = booleanChannelContext();
            struct.createDevice(dev, () => {
                struct.dssObjects[STATE_ID].onChange({ some: 'object' });
                setTimeout(() => {
                    expect(writes, 'nothing may be sent').to.deep.equal([]);
                    expect(warnings.join(' '), 'the rejection must be visible').to.contain(STATE_ID);
                    done();
                }, 10);
            });
        });
    });

    describe('apartment ventilation status', () => {
        // Regression: the state was created as boolean, which turned every status code
        // other than 0 into "true" and lost the difference between malfunction and service.
        it('is a numeric state with the DSS status codes', () => {
            const definition = dssConstants.sensorUnitRoleMap[60];
            expect(definition.type, 'the constants declare a status code').to.equal('number');
            [0, 2, 4, 6].forEach(code =>
                expect(definition.states, `status code ${code} must be named`).to.have.property(String(code)),
            );
            expect(definition.states[0]).to.equal('OK');
            expect(definition.states[2]).to.equal('Malfunction');
            expect(definition.states[4]).to.equal('Service');
            expect(definition.states[6]).to.equal('Malfunction+Service');
        });

        it('creates the apartment state with the numeric definition', () => {
            const struct = createStructure();
            struct.addStateObject('apartment.sensors.VentilationStatusValue', '0.sensors.60', {
                ...dssConstants.sensorUnitRoleMap[60],
                name: 'Ventilation Status',
                read: true,
                write: false,
            });
            const obj = struct.dssObjects['apartment.sensors.VentilationStatusValue'];
            expect(obj.common.type, 'a boolean would collapse 2, 4 and 6 to true').to.equal('number');
            expect(obj.common.states[6]).to.equal('Malfunction+Service');
            expect(struct.stateMap['0.sensors.60']).to.equal('apartment.sensors.VentilationStatusValue');
        });
    });

    describe('scene state ids', () => {
        function convert(name) {
            return createStructure().convertSceneName(name);
        }

        // Regression: scene 22 and scene 25 were both called "Preset 24", so they produced
        // the same state id - one scene silently overwrote the other.
        it('produces a unique state id for every zone scene', () => {
            const seen = {};
            Object.keys(dssConstants.zoneSceneCommands).forEach(sceneId => {
                const stateName = convert(dssConstants.zoneSceneCommands[sceneId]);
                expect(seen[stateName], `scene ${sceneId} collides with scene ${seen[stateName]}`).to.equal(undefined);
                seen[stateName] = sceneId;
            });
        });

        it('produces a unique state id for every apartment scene', () => {
            const seen = {};
            Object.keys(dssConstants.apartmentScenes).forEach(sceneId => {
                const stateName = convert(dssConstants.apartmentScenes[sceneId]);
                expect(seen[stateName], `scene ${sceneId} collides with scene ${seen[stateName]}`).to.equal(undefined);
                seen[stateName] = sceneId;
            });
        });

        it('produces a unique state id for every special group scene', () => {
            ['temperatureControlScenes', 'ventilationControlScenes'].forEach(mapName => {
                const seen = {};
                Object.keys(dssConstants[mapName]).forEach(sceneId => {
                    const stateName = convert(dssConstants[mapName][sceneId]);
                    expect(
                        seen[stateName],
                        `${mapName}: scene ${sceneId} collides with scene ${seen[stateName]}`,
                    ).to.equal(undefined);
                    seen[stateName] = sceneId;
                });
            });
        });

        it('keeps scene 22 and scene 25 apart and maps them to the right presets', () => {
            expect(dssConstants.zoneSceneCommands[22]).to.equal('Preset 14');
            expect(dssConstants.zoneSceneCommands[25]).to.equal('Preset 24');
            expect(convert(dssConstants.zoneSceneCommands[22])).to.not.equal(
                convert(dssConstants.zoneSceneCommands[25]),
            );
        });
    });

    describe('initial scene state of special groups', () => {
        // Regression: the initial state was resolved with the generic scene names, so
        // group 48 scene 0 activated "Preset0" while every event toggled "HeatingOff".
        it('uses the state map instead of the generic scene name', () => {
            const struct = createStructure();
            const groupBaseId = 'apartment.zones.5.groups.48';
            // Both states exist for group 48, the special one owns the DSS key
            struct.dssObjects[`${groupBaseId}.scenes.Preset0`] = { type: 'state', common: {} };
            struct.dssObjects[`${groupBaseId}.scenes.HeatingOff`] = { type: 'state', common: {} };
            struct.stateMap['5.48.scenes.0'] = `${groupBaseId}.scenes.HeatingOff`;

            const stateId = struct.resolveSceneStateId('5.48.scenes.0', 0, groupBaseId);
            expect(stateId, 'the special scene state must win').to.equal(`${groupBaseId}.scenes.HeatingOff`);
            expect(struct.resolveSceneStateName(0), 'the generic name still resolves to Preset0').to.equal('Preset0');
        });

        it('does the same for the ventilation groups', () => {
            const struct = createStructure();
            const groupBaseId = 'apartment.zones.7.groups.10';
            struct.stateMap['7.10.scenes.0'] = `${groupBaseId}.scenes.Off`;
            expect(struct.resolveSceneStateId('7.10.scenes.0', 0, groupBaseId)).to.equal(`${groupBaseId}.scenes.Off`);
        });

        it('falls back to the generic name when the scene is not in the state map', () => {
            const struct = createStructure();
            expect(struct.resolveSceneStateId('5.1.scenes.0', 0, 'apartment.zones.5.groups.1')).to.equal(
                'apartment.zones.5.groups.1.scenes.Preset0',
            );
            expect(struct.resolveSceneStateId('5.1.scenes.9999', 9999, 'apartment.zones.5.groups.1')).to.equal(null);
        });

        it('activates only the special state of group 48 during processGroup', done => {
            const struct = createStructure({
                dssQueue: {
                    pushQueryQueue: (...args) => {
                        const callback = args[args.length - 1];
                        // The DSS reports scene 0 as the last called scene
                        setImmediate(() => callback(null, { ok: true, result: { scene: 0 } }));
                    },
                },
                adapter: { log: silentLogger, config: {}, setState: () => {} },
            });
            struct.propertyStates = [];
            const group = { id: 48, name: 'Temperature Control', isPresent: true, isValid: true, devices: ['dev1'] };
            struct.processGroup('apartment.zones.5.groups.48', 5, group, () => {
                const base = 'apartment.zones.5.groups.48';
                expect(
                    struct.initialObjectValues[`${base}.scenes.HeatingOff`],
                    'the state the events use must be the active one',
                ).to.equal(true);
                expect(
                    struct.initialObjectValues[`${base}.scenes.Preset0`],
                    'the generic state must not be active at the same time',
                ).to.equal(false);
                done();
            });
        });
    });

    describe('unmapped property states', () => {
        function reportingStructure(entries) {
            return createStructure({
                adapter: {
                    log: Object.assign({}, silentLogger, {
                        info: msg => entries.push(String(msg)),
                    }),
                    config: {},
                },
            });
        }

        it('reports states that belong to no device, room, group or the apartment', () => {
            const entries = [];
            const struct = reportingStructure(entries);
            struct.propertyStates = [
                { name: 'presence', state: 'active' },
                { name: 'zone.5.heating', state: 'inactive' },
                // A state of a device the DSS does not list in the apartment structure,
                // e.g. an EnOcean window contact on a DSB
                { name: 'dev.302ed89f43f000000000458002a35af000.302ed89f43f000000000458002a35af000_open-tilded' },
            ];
            // The apartment and the zone claim their states, the device does not exist
            struct.findStates('^([^.]*)$');
            struct.findStates('^zone\\.5\\.([^.]*)$');

            struct.reportUnmappedStates();

            expect(entries, 'exactly one summary line').to.have.lengthOf(1);
            expect(entries[0]).to.contain('open-tilded');
            expect(entries[0], 'the claimed states must not be listed').to.not.contain('zone.5.heating');
            expect(entries[0]).to.not.contain('"presence"');
        });

        it('stays quiet when every state was assigned', () => {
            const entries = [];
            const struct = reportingStructure(entries);
            struct.propertyStates = [{ name: 'presence', state: 'active' }];
            struct.findStates('^([^.]*)$');
            struct.reportUnmappedStates();
            expect(entries).to.deep.equal([]);
        });

        it('survives missing or broken property states', () => {
            const entries = [];
            const struct = reportingStructure(entries);
            struct.propertyStates = undefined;
            expect(() => struct.reportUnmappedStates()).to.not.throw();
            struct.propertyStates = [null, { noName: true }];
            struct.reportUnmappedStates();
            expect(entries, 'unusable entries are not reported as missing states').to.deep.equal([]);
        });
    });

    describe('instance isolation', () => {
        // Regression: this.groupTypes referenced the shared constants object, so a cluster
        // name of one apartment leaked into every other instance of the same process.
        it('gives every structure its own group type map', () => {
            const originalName = dssConstants.groupTypes[16];
            const first = createStructure();
            const second = createStructure();

            first.groupTypes[16] = 'Cluster Erdgeschoss';
            expect(second.groupTypes[16], 'a second instance must not see it').to.equal(originalName);
            expect(dssConstants.groupTypes[16], 'the module constants must stay untouched').to.equal(originalName);
        });

        it('keeps two apartments with the same cluster id apart', () => {
            const first = createStructure();
            const second = createStructure();
            first.apartmentStructure = {
                clusters: [{ id: 16, name: 'Rollladen Nord' }],
                floors: [],
                zones: [],
            };
            second.apartmentStructure = {
                clusters: [{ id: 16, name: 'Rollladen Sued' }],
                floors: [],
                zones: [],
            };
            // parseData aborts without zone 0, the cluster merge happens before that
            first.parseData(() => {});
            second.parseData(() => {});

            expect(first.groupTypes[16]).to.equal('Rollladen Nord');
            expect(second.groupTypes[16]).to.equal('Rollladen Sued');
            expect(dssConstants.groupTypes[16], 'no global mutation').to.equal(undefined);
        });
    });

    describe('expected queue errors', () => {
        function loggingStructure(levels) {
            return createStructure({
                adapter: {
                    log: Object.assign({}, silentLogger, {
                        debug: () => levels.push('debug'),
                        info: () => levels.push('info'),
                        warn: () => levels.push('warn'),
                    }),
                    config: {},
                },
            });
        }

        // Regression: a coalesced write produced
        // "Error while set State for apartment-user: SupersededError: ..." as a warning,
        // although replacing a not yet sent value is normal last-write-wins behaviour.
        it('reports a superseded request as debug, not as warning', () => {
            const levels = [];
            loggingStructure(levels).logQueueError(
                'Error while set State for apartment-user',
                new DSSQueue.SupersededError('Request was superseded by a newer value'),
            );
            expect(levels).to.deep.equal(['debug']);
        });

        it('still warns about a real DSS error', () => {
            const levels = [];
            loggingStructure(levels).logQueueError('Error while set State for apartment-user', new Error('HTTP 500'));
            expect(levels).to.deep.equal(['warn']);
        });

        it('still warns when the DSS answered with ok=false and no error object', () => {
            const levels = [];
            loggingStructure(levels).logQueueError('Error while callScene for group: {"ok":false}', undefined);
            expect(levels).to.deep.equal(['warn']);
        });

        it('treats a superseded output write as expected', () => {
            const levels = [];
            loggingStructure(levels).logOutputWriteError(
                { dSUID: 'dev1' },
                new DSSQueue.SupersededError('superseded by a newer value'),
            );
            expect(levels).to.deep.equal(['debug']);
        });

        it('does not burn the "reported once" slot of an output read on a shutdown', () => {
            const levels = [];
            const struct = loggingStructure(levels);
            const shutdownErr = Object.assign(new Error('Queue cleared'), { shutdown: true });
            struct.logOutputReadError({ dSUID: 'dev1' }, 'brightness', shutdownErr);
            expect(levels, 'a stop is not a device property').to.deep.equal(['debug']);
            // The real report must still be possible afterwards
            struct.logOutputReadError({ dSUID: 'dev1' }, 'brightness', new Error('HTTP 500'));
            expect(levels).to.deep.equal(['debug', 'info']);
        });
    });
});
