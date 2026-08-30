const { expect } = require('chai');
const proxyquire = require('proxyquire');
const DSS = require('../lib/dss');
const dssConstants = require('../lib/constants');

// adapter-core needs a running js-controller, which is not available in unit tests.
// Only prototype methods and statics are used here, no instance is created.
const { Digitalstrom } = proxyquire('../main', {
    '@iobroker/adapter-core': {
        Adapter: class FakeAdapter {
            on() {}
        },
        '@noCallThru': true,
    },
    '@apollon/iobroker-tools': {
        objectHelper: { init: () => {} },
        '@noCallThru': true,
    },
});

const silentLog = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// Shape of a real digitalSTROM application token (64 hex characters)
const VALID_APP_TOKEN = 'a1b2c3d4'.repeat(8);

/**
 * Builds a minimal adapter-like context so the adapter methods can be tested
 * without a running js-controller.
 *
 * @param {object} [overrides]
 * @returns {object} fake adapter context
 */
function createContext(overrides = {}) {
    const ctx = {
        log: silentLog,
        config: {},
        connected: null,
        states: {},
        stateMapEntries: {},
        restarts: [],
        lastScenes: {},
        stopping: false,
        stopped: false,
        stopCallbacks: [],
        tokenConnections: new Set(),
        eventHandlersRegistered: false,
        setState(id, value) {
            this.states[id] = value;
        },
        isStopping: Digitalstrom.prototype.isStopping,
        registerEventHandlers: Digitalstrom.prototype.registerEventHandlers,
        resyncSceneStates: Digitalstrom.prototype.resyncSceneStates,
        setConnected: Digitalstrom.prototype.setConnected,
        coerceScalarValue: Digitalstrom.prototype.coerceScalarValue,
        coerceStateValue: Digitalstrom.prototype.coerceStateValue,
        setDssState: Digitalstrom.prototype.setDssState,
        normalizeConfig: Digitalstrom.prototype.normalizeConfig,
        restartAdapter(timeout) {
            this.restarts.push(timeout);
        },
        eventLog: Digitalstrom.prototype.eventLog,
        subscribeStates: () => {},
        startDataPolling: () => {},
        clearAdditionalObjects: () => {},
        ...overrides,
    };
    return ctx;
}

describe('Adapter logic', () => {
    describe('normalizePollInterval', () => {
        const cases = [
            // A cycle reads two values per circuit and the timer only starts afterwards, so
            // 100s is the first interval that stays within DSS rules 8/9
            [undefined, 100000, 'default when unset'],
            [null, 100000, 'default when null'],
            ['', 100000, 'default when empty'],
            [60, 60000, 'the configured minimum stays possible'],
            [100, 100000, 'the default itself'],
            ['120', 120000, 'numeric string'],
            [0, 0, 'zero disables polling'],
            ['0', 0, 'zero as string disables polling'],
            [-5, 0, 'negative disables instead of firing immediately'],
            [NaN, 100000, 'NaN falls back to default'],
            [Infinity, 100000, 'Infinity falls back to default'],
            ['abc', 100000, 'garbage falls back to default'],
            [1, 60000, 'too small values are raised to the minimum'],
            ['30', 60000, 'values below the minimum are raised to 60s'],
            [59, 60000, 'just below the minimum is raised to 60s'],
            [999999999, 24 * 60 * 60 * 1000, 'huge values are capped'],
            [120.4, 120000, 'fractions are rounded'],
        ];
        cases.forEach(([input, expected, label]) => {
            it(String(label), () => {
                expect(Digitalstrom.normalizePollInterval(input)).to.equal(expected);
            });
        });

        it('never produces an interval below the configured minimum', () => {
            [-1000, -1, 0.4, '-99', 1, 10, 59].forEach(input => {
                const result = Digitalstrom.normalizePollInterval(input);
                expect(result === 0 || result >= 60000, `bad interval for ${input}: ${result}`).to.equal(true);
            });
        });

        // Two requests per circuit and cycle plus roughly 20s until the timer restarts:
        // only from 100s on the adapter stays at or below one request per minute and circuit
        it('keeps the default within the request limit of the DSS', () => {
            const cycleSeconds = Digitalstrom.normalizePollInterval(undefined) / 1000 + 20;
            const requestsPerMinute = (2 / cycleSeconds) * 60;
            expect(requestsPerMinute, `default results in ${requestsPerMinute}/min`).to.be.at.most(1);
        });
    });

    describe('coerceStateValue', () => {
        function ctxWith(objects) {
            return createContext({ dssStruct: { dssObjects: objects, stateMap: {}, zoneDevices: {} } });
        }

        it('converts DSS strings to numbers', () => {
            const ctx = ctxWith({ 'apartment.sensors.outdoor.temperature': { common: { type: 'number' } } });
            const coerce = Digitalstrom.prototype.coerceStateValue.bind(ctx);
            expect(coerce('apartment.sensors.outdoor.temperature', '18.5')).to.equal(18.5);
            expect(coerce('apartment.sensors.outdoor.temperature', '-3')).to.equal(-3);
            expect(coerce('apartment.sensors.outdoor.temperature', 21)).to.equal(21);
        });

        it('converts DSS strings to booleans', () => {
            const ctx = ctxWith({ 'apartment.states.daynight_indoors_state': { common: { type: 'boolean' } } });
            const coerce = Digitalstrom.prototype.coerceStateValue.bind(ctx);
            expect(coerce('apartment.states.daynight_indoors_state', 'true')).to.equal(true);
            expect(coerce('apartment.states.daynight_indoors_state', 'false')).to.equal(false);
        });

        it('uses the value mapping of the object for booleans', () => {
            const ctx = ctxWith({
                'apartment.0.4.states.heating': {
                    common: { type: 'boolean' },
                    native: { valueTrue: 'active', valueFalse: 'inactive' },
                },
            });
            const coerce = Digitalstrom.prototype.coerceStateValue.bind(ctx);
            expect(coerce('apartment.0.4.states.heating', 'active')).to.equal(true);
            expect(coerce('apartment.0.4.states.heating', 'inactive')).to.equal(false);
            // an unmapped value must still end up as a boolean, never as a string
            expect(coerce('apartment.0.4.states.heating', 'off')).to.equal(false);
            expect(coerce('apartment.0.4.states.heating', 'on')).to.equal(true);
        });

        it('converts numbers to strings for string states', () => {
            const ctx = ctxWith({ 'some.state': { common: { type: 'string' } } });
            expect(Digitalstrom.prototype.coerceStateValue.call(ctx, 'some.state', 5)).to.equal('5');
        });

        it('keeps null and undefined and passes unknown ids through', () => {
            const ctx = ctxWith({ 'a.number': { common: { type: 'number' } } });
            const coerce = Digitalstrom.prototype.coerceStateValue.bind(ctx);
            expect(coerce('a.number', null)).to.equal(null);
            expect(coerce('a.number', undefined)).to.equal(undefined);
            expect(coerce('unknown.id', 'text')).to.equal('text');
        });

        it('maps a non numeric string to null instead of NaN', () => {
            const ctx = ctxWith({ 'a.number': { common: { type: 'number' } } });
            expect(Digitalstrom.prototype.coerceStateValue.call(ctx, 'a.number', 'n/a')).to.equal(null);
        });

        it('converts only the value of a state object with timestamp', () => {
            // The outdoor sensors bring their own DSS timestamp as { val, ts }
            const ctx = ctxWith({ 'apartment.sensors.outdoor.humidity': { common: { type: 'number' } } });
            const res = Digitalstrom.prototype.coerceStateValue.call(ctx, 'apartment.sensors.outdoor.humidity', {
                val: '54.4',
                ts: 1700000000000,
            });
            expect(res).to.deep.equal({ val: 54.4, ts: 1700000000000 });
        });
    });

    describe('state changes during unload', () => {
        function changeContext() {
            const handled = [];
            return createContext({
                objectHelper: { handleStateChange: (id, state) => handled.push([id, state.val]) },
                handled,
            });
        }

        it('forwards a state change before the stop', () => {
            const ctx = changeContext();
            Digitalstrom.prototype.onStateChange.call(ctx, 'digitalstrom.0.x', { val: 5, ack: false });
            expect(ctx.handled).to.deep.equal([['digitalstrom.0.x', 5]]);
        });

        it('ignores a state change while the adapter is stopping', () => {
            const ctx = changeContext();
            ctx.stopping = true;
            Digitalstrom.prototype.onStateChange.call(ctx, 'digitalstrom.0.x', { val: 5, ack: false });
            expect(ctx.handled, 'no new command may be started during the unload').to.deep.equal([]);
        });

        it('ignores a state change after the adapter stopped', () => {
            const ctx = changeContext();
            ctx.stopping = true;
            ctx.stopped = true;
            Digitalstrom.prototype.onStateChange.call(ctx, 'digitalstrom.0.x', { val: 5, ack: false });
            expect(ctx.handled).to.deep.equal([]);
        });

        it('stops the queue during the unload instead of only clearing it', done => {
            const DSSQueue = require('../lib/dssQueue');
            const queue = new DSSQueue({
                logger: silentLog,
                prioTimeouts: { high: 1, medium: 2, low: 3 },
                dss: { requestAsync: async () => ({ ok: true }) },
            });
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            const ctx = createContext({
                dss,
                dssQueue: queue,
                dssStruct: { clearTimeouts: () => {} },
                stopGuardTimeout: 20,
            });
            Digitalstrom.prototype.stopAdapter.call(ctx, () => {
                expect(queue.stopped, 'the queue must be closed after the unload').to.equal(true);
                // a late command must not reach the already closed DSS client
                queue.pushQueryQueue(
                    'c1',
                    'late',
                    { dssClass: 'zone', dssFunction: 'callScene', params: {} },
                    'high',
                    err => {
                        expect(err.shutdown).to.equal(true);
                        done();
                    },
                );
            });
        });
    });

    describe('deleteUnknownObjects safety', () => {
        function deleteContext(configValue) {
            const deleted = [];
            const ctx = createContext({
                config: { deleteUnknownObjects: configValue },
                objectHelper: { existingStates: { 'devices.a.b': {}, 'devices.c.d': {} } },
                delObject: (id, cb) => {
                    deleted.push(id);
                    cb(null);
                },
                clearAdditionalObjects: Digitalstrom.prototype.clearAdditionalObjects,
            });
            ctx.deleted = deleted;
            return ctx;
        }

        // Everything that is not unambiguously true must keep the objects
        const mustNotDelete = [
            ['boolean false', false],
            ['string "false"', 'false'],
            ['string "0"', '0'],
            ['string "no"', 'no'],
            ['string "off"', 'off'],
            ['empty string', ''],
            ['whitespace', '   '],
            ['null', null],
            ['undefined', undefined],
            ['object', {}],
            ['invalid string', 'vielleicht'],
            ['number 0', 0],
        ];

        mustNotDelete.forEach(([label, value]) => {
            it(`keeps the objects for ${label}`, done => {
                const ctx = deleteContext(value);
                ctx.clearAdditionalObjects(() => {
                    expect(ctx.deleted, `${label} must never delete objects`).to.deep.equal([]);
                    done();
                });
            });
        });

        [
            ['boolean true', true],
            ['string "true"', 'true'],
            ['number 1', 1],
        ].forEach(([label, value]) => {
            it(`deletes the objects only for ${label}`, done => {
                const ctx = deleteContext(value);
                ctx.clearAdditionalObjects(() => {
                    expect(ctx.deleted).to.deep.equal(['devices.a.b', 'devices.c.d']);
                    done();
                });
            });
        });
    });

    describe('normalizeConfig', () => {
        function configContext(config) {
            const warnings = [];
            return createContext({
                config,
                warnings,
                log: { ...silentLog, warn: msg => warnings.push(String(msg)) },
                normalizeConfig: Digitalstrom.prototype.normalizeConfig,
            });
        }

        it('turns the string "false" into a real false', () => {
            const ctx = configContext({
                deleteUnknownObjects: 'false',
                initializeOutputValues: 'false',
                usePresetValues: 'false',
                validateCertificate: 'false',
            });
            ctx.normalizeConfig();
            expect(ctx.config.deleteUnknownObjects).to.equal(false);
            expect(ctx.config.initializeOutputValues).to.equal(false);
            expect(ctx.config.usePresetValues).to.equal(false);
            expect(ctx.config.validateCertificate).to.equal(false);
            expect(ctx.warnings, 'a clean string value needs no warning').to.deep.equal([]);
        });

        it('applies the documented defaults when values are missing', () => {
            const ctx = configContext({});
            ctx.normalizeConfig();
            expect(ctx.config.usePresetValues, 'default true').to.equal(true);
            expect(ctx.config.initializeOutputValues, 'default true').to.equal(true);
            expect(ctx.config.deleteUnknownObjects, 'destructive - default false').to.equal(false);
            expect(ctx.config.validateCertificate, 'documented default false').to.equal(false);
            expect(ctx.warnings, 'missing values are normal, no warning').to.deep.equal([]);
        });

        it('warns about uninterpretable values instead of failing silently', () => {
            const ctx = configContext({ validateCertificate: 'vielleicht', deleteUnknownObjects: {} });
            ctx.normalizeConfig();
            expect(ctx.config.validateCertificate).to.equal(false);
            expect(ctx.config.deleteUnknownObjects).to.equal(false);
            expect(ctx.warnings).to.have.lengthOf(2);
            expect(ctx.warnings.join('\n')).to.contain('validateCertificate');
            expect(ctx.warnings.join('\n')).to.contain('deleteUnknownObjects');
        });

        it('keeps real booleans untouched', () => {
            const ctx = configContext({
                deleteUnknownObjects: true,
                usePresetValues: false,
                validateCertificate: true,
            });
            ctx.normalizeConfig();
            expect(ctx.config.deleteUnknownObjects).to.equal(true);
            expect(ctx.config.usePresetValues).to.equal(false);
            expect(ctx.config.validateCertificate).to.equal(true);
            expect(ctx.warnings).to.deep.equal([]);
        });
    });

    describe('invalid host handling', () => {
        // Every one of these makes the DSS constructor throw synchronously
        const invalidHosts = [
            ['empty', ''],
            ['whitespace', '   '],
            ['null', null],
            ['undefined', undefined],
            ['object instead of string', { host: '1.2.3.4' }],
            ['unsupported scheme', 'ftp://192.168.1.10'],
            ['with path', 'https://192.168.1.10/path'],
            ['with credentials', 'https://user:password@192.168.1.10'],
            ['with query string', 'https://192.168.1.10?a=b'],
            ['with fragment', 'https://192.168.1.10#x'],
            ['invalid port', 'https://192.168.1.10:notaport'],
            ['incomplete IPv6', 'https://[2001:db8'],
        ];

        invalidHosts.forEach(([label, host]) => {
            it(`buildBaseUrl rejects ${label}`, () => {
                expect(() => DSS.buildBaseUrl(/** @type {string} */ (host))).to.throw();
            });
        });

        describe('adapter start', () => {
            function startContext(host) {
                const log = {
                    ...silentLog,
                    /** @type {string[]} */
                    errors: [],
                    /**
                     * @param {unknown} msg
                     */
                    error(msg) {
                        // Reads the property instead of a captured array, so a test may
                        // replace log.errors before it runs
                        log.errors.push(String(msg));
                    },
                };
                return createContext({
                    // A real DSS app token is a long hex string - a placeholder would trigger
                    // the plausibility check of main() and produce an extra error line
                    config: { host, appToken: VALID_APP_TOKEN },
                    errors: log.errors,
                    log,
                    objectHelper: { loadExistingObjects: cb => cb() },
                    normalizePollInterval: Digitalstrom.normalizePollInterval,
                    // main() fragt den Client der neuen API an. Ohne konfigurierten
                    // Schalter liefert die Methode null, der Start laeuft also wie bisher.
                    createSmartHomeClient: Digitalstrom.prototype.createSmartHomeClient,
                });
            }

            invalidHosts.forEach(([label, host]) => {
                it(`does not throw on start with ${label}`, () => {
                    const ctx = startContext(host);
                    ctx.log.errors = [];
                    ctx.errors = ctx.log.errors;
                    expect(() => Digitalstrom.prototype.main.call(ctx)).to.not.throw();
                    // no DSS client, no timers, no restart loop. An empty host is already
                    // rejected by the config check before the client is built, so dss stays unset.
                    expect(
                        ctx.dss === null || ctx.dss === undefined,
                        'no half initialized client must be kept',
                    ).to.equal(true);
                    expect(ctx.startupTimeout, 'no watchdog timer must be started').to.equal(undefined);
                    expect(ctx.restarts, 'an invalid host must not trigger a restart loop').to.deep.equal([]);
                    expect(ctx.states['info.connection'], 'connection must be reported as false').to.equal(false);
                });
            });

            it('logs a helpful error without leaking the app token', () => {
                const ctx = startContext('ftp://192.168.1.10');
                ctx.log.errors = [];
                // Same shape as a real token so only the host error is reported
                ctx.config.appToken = 'deadbeef'.repeat(8);
                Digitalstrom.prototype.main.call(ctx);
                expect(ctx.log.errors).to.have.lengthOf(1);
                expect(ctx.log.errors[0]).to.contain('only https and http are supported');
                expect(ctx.log.errors[0]).to.not.contain('deadbeef');
            });

            // A token js-controller could not decrypt comes back as garbage. Without this
            // check the user would only see "Login failed" and had no idea what to do.
            it('warns about a token that could not be read back', () => {
                const ctx = startContext('192.168.1.10');
                ctx.log.errors = [];
                ctx.config.appToken = '\u0012\u00a4garbled-token\u0099';
                Digitalstrom.prototype.main.call(ctx);
                const hint = ctx.log.errors.find(msg => msg.includes('does not look like a valid'));
                expect(hint, 'the user must get an actionable message').to.be.a('string');
                expect(hint).to.contain('enter the App-Token again');
                // The login is still attempted, the check never blocks the start
                expect(ctx.dss, 'the client must still be created').to.not.equal(null);
                ctx.dss.stop();
                clearTimeout(ctx.startupTimeout);
            });

            it('accepts a real looking app token without complaining', () => {
                expect(Digitalstrom.looksLikeAppToken('deadbeef'.repeat(8))).to.equal(true);
                expect(Digitalstrom.looksLikeAppToken('ABCDEF0123456789'.repeat(2))).to.equal(true);
                expect(Digitalstrom.looksLikeAppToken('garbled token'), 'spaces are impossible').to.equal(false);
                expect(Digitalstrom.looksLikeAppToken('abc'), 'too short').to.equal(false);
                expect(Digitalstrom.looksLikeAppToken(''), 'empty').to.equal(false);
                expect(Digitalstrom.looksLikeAppToken(undefined)).to.equal(false);
            });

            it('starts normally with a valid host', () => {
                const ctx = startContext('192.168.1.10');
                ctx.log.errors = [];
                Digitalstrom.prototype.main.call(ctx);
                expect(ctx.dss, 'a valid host must create the client').to.not.equal(null);
                expect(ctx.log.errors).to.deep.equal([]);
                ctx.dss.stop();
                clearTimeout(ctx.startupTimeout);
            });
        });

        describe('createAppToken message', () => {
            function messageContext(host) {
                const answers = [];
                const ctx = createContext({
                    config: {},
                    log: { ...silentLog },
                    sendTo: (from, command, result, callback) => answers.push({ from, command, result, callback }),
                });
                ctx.answers = answers;
                ctx.msg = {
                    command: 'createAppToken',
                    from: 'system.adapter.admin.0',
                    callback: { id: 1 },
                    message: { host, username: 'user', password: 'p@ss"\\word' },
                };
                return ctx;
            }

            invalidHosts.forEach(([label, host]) => {
                it(`answers the admin dialog instead of crashing with ${label}`, () => {
                    const ctx = messageContext(host);
                    expect(() => Digitalstrom.prototype.onMessage.call(ctx, ctx.msg)).to.not.throw();
                    expect(ctx.answers, 'the dialog must always get an answer').to.have.lengthOf(1);
                    expect(ctx.answers[0].result).to.have.property('error');
                    expect(ctx.answers[0].callback).to.deep.equal({ id: 1 });
                    // the password must never end up in the answer
                    expect(JSON.stringify(ctx.answers[0].result)).to.not.contain('p@ss');
                });
            });

            it('does not log the username or password', () => {
                const logged = [];
                const ctx = messageContext('ftp://192.168.1.10');
                ['silly', 'debug', 'info', 'warn', 'error'].forEach(level => {
                    ctx.log[level] = msg => logged.push(String(msg));
                });
                Digitalstrom.prototype.onMessage.call(ctx, ctx.msg);
                const all = logged.join('\n');
                expect(all).to.not.contain('p@ss');
                expect(all, 'the username is part of the credentials').to.not.contain('user');
            });
        });
    });

    describe('registerObjects', () => {
        it('converts the initial value to the declared type of the object', () => {
            const created = [];
            const dssObjects = {
                'apartment.0.4.states.heating': {
                    type: 'state',
                    common: { type: 'boolean', role: 'indicator' },
                    native: { valueTrue: 'active', valueFalse: 'inactive' },
                    value: 'inactive',
                },
                'apartment.sensors.outdoor.temperature': {
                    type: 'state',
                    common: { type: 'number', role: 'value.temperature' },
                    native: {},
                    value: { val: '18.5', ts: 42 },
                },
            };
            const ctx = createContext({
                dssStruct: { dssObjects },
                objectHelper: {
                    setOrUpdateObject: (id, obj, preserve, value) => created.push([id, value]),
                },
            });

            Digitalstrom.prototype.registerObjects.call(ctx);

            expect(created).to.deep.equal([
                ['apartment.0.4.states.heating', false],
                ['apartment.sensors.outdoor.temperature', { val: 18.5, ts: 42 }],
            ]);
            // value/onChange must not end up in the created object
            expect(dssObjects['apartment.0.4.states.heating']).to.not.have.property('value');
        });
    });

    describe('event handlers', () => {
        function subscribedContext() {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            // no real polling in this test
            dss.pollChannel = () => {};

            const ctx = createContext({
                dss,
                dssStruct: {
                    stateMap: {
                        'dev1.0.button': 'devices.m1.dev1.button',
                        'dev1.0.buttonClickType': 'devices.m1.dev1.buttonClickType',
                        'dev1.0.buttonHoldCount': 'devices.m1.dev1.buttonHoldCount',
                    },
                    zoneDevices: {},
                    dssObjects: {},
                    apartmentStructure: { zones: [] },
                },
            });
            return { ctx, dss };
        }

        it('keeps clickType 0 instead of turning it into -1', done => {
            const { ctx, dss } = subscribedContext();
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, err => {
                expect(err).to.equal(null);
                dss.emit('buttonClick', {
                    name: 'buttonClick',
                    source: { isDevice: true, dSUID: 'dev1' },
                    properties: { clickType: 0, holdCount: 0 },
                });
                expect(ctx.states['devices.m1.dev1.buttonClickType'], 'clickType 0 must stay 0').to.equal(0);
                expect(ctx.states['devices.m1.dev1.buttonHoldCount']).to.equal(0);
                dss.stop();
                done();
            });
        });

        it('writes zone sensor values as numbers, not as DSS strings', done => {
            const { ctx, dss } = subscribedContext();
            ctx.dssStruct.stateMap['4.sensors.9'] = 'apartment.0.4.sensors.TemperatureValue';
            ctx.dssStruct.dssObjects['apartment.0.4.sensors.TemperatureValue'] = { common: { type: 'number' } };
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                dss.emit('zoneSensorValue', {
                    name: 'zoneSensorValue',
                    source: { zoneID: '4' },
                    properties: { sensorType: '9', sensorValueFloat: '21.5' },
                });
                expect(ctx.states['apartment.0.4.sensors.TemperatureValue']).to.equal(21.5);
                dss.stop();
                done();
            });
        });

        it('still maps a missing clickType to -1', done => {
            const { ctx, dss } = subscribedContext();
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                dss.emit('buttonClick', {
                    name: 'buttonClick',
                    source: { isDevice: true, dSUID: 'dev1' },
                    properties: {},
                });
                expect(ctx.states['devices.m1.dev1.buttonClickType']).to.equal(-1);
                dss.stop();
                done();
            });
        });
    });

    describe('subscription failures during startup', () => {
        it('reports an error when part of the subscriptions failed', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            const activeEvents = Object.keys(dssConstants.availableEvents).filter(
                name => dssConstants.availableEvents[name],
            );
            let call = 0;
            dss.requestAsync = async () => {
                call++;
                if (call % 2 === 0) {
                    throw new Error('subscribe denied');
                }
                return { ok: true };
            };
            dss.pollChannel = () => {};

            const ctx = createContext({ dss, dssStruct: { stateMap: {}, zoneDevices: {} } });
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, err => {
                expect(err, 'a failed subscription must be reported').to.be.an('error');
                expect(err.message).to.contain('event subscriptions failed');
                expect(err.message).to.contain(`of ${activeEvents.length}`);
                dss.stop();
                done();
            });
        });

        it('reports no error when all subscriptions succeed', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.pollChannel = () => {};
            const ctx = createContext({ dss, dssStruct: { stateMap: {}, zoneDevices: {} } });
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, err => {
                expect(err).to.equal(null);
                dss.stop();
                done();
            });
        });

        it('does not report a connection when the subscriptions failed', () => {
            // Mirrors the startup path: on a subscription error info.connection stays false
            const ctx = createContext();
            ctx.setConnected(false);
            expect(ctx.states['info.connection']).to.equal(false);
            expect(ctx.connected).to.equal(false);
        });
    });

    describe('stop handling', () => {
        function stoppableContext(dss) {
            return createContext({
                dss,
                dssQueue: { stop: () => {}, clearQueues: () => {} },
                dssStruct: { clearTimeouts: () => {} },
                stopGuardTimeout: 50,
            });
        }

        it('answers every caller exactly once', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.subscriptions.eventA = { subscriptionId: 42, timeout: 100 };
            dss.ensureChannel(42, 100);
            const ctx = stoppableContext(dss);

            let firstCalls = 0;
            let secondCalls = 0;
            Digitalstrom.prototype.stopAdapter.call(ctx, () => firstCalls++);
            Digitalstrom.prototype.stopAdapter.call(ctx, () => secondCalls++);

            setTimeout(() => {
                expect(firstCalls, 'first caller answered once').to.equal(1);
                expect(secondCalls, 'second caller answered once').to.equal(1);
                // A caller after the stop finished must still be answered
                let lateCalls = 0;
                Digitalstrom.prototype.stopAdapter.call(ctx, () => lateCalls++);
                expect(lateCalls, 'late caller answered once').to.equal(1);
                done();
            }, 120);
        });

        it('closes the DSS client even when unsubscribing hangs', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = () => new Promise(() => {}); // unsubscribe never returns
            dss.subscriptions.eventA = { subscriptionId: 42, timeout: 100 };
            dss.ensureChannel(42, 100);
            const ctx = stoppableContext(dss);

            Digitalstrom.prototype.stopAdapter.call(ctx, () => {
                expect(dss.stopped, 'the DSS client must be closed by the guard path').to.equal(true);
                done();
            });
        });
    });

    describe('the stop is a barrier for late startup callbacks', () => {
        // Regression: asynchronous startup callbacks kept running after the unload and
        // created timers, subscriptions and connected = true on an already stopped adapter.
        it('never reports connected again after the stop', () => {
            const ctx = createContext();
            ctx.setConnected(true);
            expect(ctx.states['info.connection']).to.equal(true);

            ctx.stopping = true;
            ctx.stopped = true;
            ctx.connected = false;
            ctx.states['info.connection'] = false;

            // A startup callback that only now reaches setConnected(true)
            ctx.setConnected(true);
            expect(ctx.states['info.connection'], 'a stopped adapter must stay disconnected').to.equal(false);
            expect(ctx.connected).to.equal(false);
        });

        it('starts no data polling after the stop', () => {
            let meterReads = 0;
            const ctx = createContext({
                dataPollInterval: 60000,
                dataPollTimeout: null,
                dssStruct: {
                    updateMeterData: cb => {
                        meterReads++;
                        cb(0, 1);
                    },
                },
            });
            ctx.stopping = true;
            Digitalstrom.prototype.startDataPolling.call(ctx);
            expect(meterReads, 'no meter read after the stop').to.equal(0);
            expect(ctx.dataPollTimeout, 'and no new timer').to.equal(null);
        });

        it('schedules no restart after the stop', () => {
            const ctx = createContext({ restartTimeout: null });
            ctx.stopped = true;
            Digitalstrom.prototype.restartAdapter.call(ctx, 1000);
            expect(ctx.restartTimeout, 'a stopped adapter must not restart itself').to.equal(null);
        });

        it('closes an App-Token client that is still running during the unload', done => {
            const tokenClient = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            const ctx = createContext({
                dssQueue: { stop: () => {}, clearQueues: () => {} },
                dssStruct: { clearTimeouts: () => {} },
                stopGuardTimeout: 20,
            });
            ctx.tokenConnections.add(tokenClient);

            Digitalstrom.prototype.stopAdapter.call(ctx, () => {
                expect(tokenClient.stopped, 'the token client must be closed by the unload').to.equal(true);
                expect(ctx.tokenConnections.size, 'and must not be kept afterwards').to.equal(0);
                done();
            });
        });

        it('answers no App-Token request that finishes after the unload', done => {
            const sent = [];
            const infos = [];
            const ctx = createContext({
                log: Object.assign({}, silentLog, { info: msg => infos.push(String(msg)) }),
                sendTo: (from, command, result, callback) => sent.push({ result, callback }),
                config: { validateCertificate: false },
            });

            /** @type {((token: string) => void)|undefined} */
            let resolveToken;
            const tokenClient = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            tokenClient.createAppTokenAsync = () =>
                new Promise(resolve => {
                    resolveToken = resolve;
                });
            ctx.tokenConnections.add(tokenClient);

            // Simulates the message handler: the answer only arrives after the unload
            tokenClient.createAppTokenAsync('user', 'pass').then(appToken => {
                ctx.tokenConnections.delete(tokenClient);
                tokenClient.stop();
                if (Digitalstrom.prototype.isStopping.call(ctx)) {
                    expect(sent, 'no late sendTo into a closed admin dialog').to.deep.equal([]);
                    expect(appToken).to.equal('token');
                    return done();
                }
                done(new Error('the stop barrier did not take effect'));
            });

            ctx.stopping = true;
            ctx.stopped = true;
            resolveToken && resolveToken('token');
        });

        it('refuses a new App-Token request during the unload', () => {
            const sent = [];
            const ctx = createContext({
                sendTo: (from, command, result) => sent.push(result),
                config: { validateCertificate: false },
            });
            ctx.stopping = true;
            Digitalstrom.prototype.onMessage.call(ctx, {
                command: 'createAppToken',
                from: 'system.adapter.admin.0',
                callback: { id: 1 },
                message: { host: 'localhost', username: 'u', password: 'p' },
            });
            expect(ctx.tokenConnections.size, 'no new client during the unload').to.equal(0);
            expect(sent).to.deep.equal([]);
        });
    });

    describe('event handler registration order', () => {
        function eventContext(dss) {
            return createContext({
                dss,
                dssStruct: {
                    stateMap: { '5.1.scenes.17': 'apartment.zones.5.groups.1.scenes.Preset2' },
                    zoneDevices: {},
                    dssObjects: {},
                    apartmentStructure: { zones: [] },
                },
            });
        }

        // Regression: the handlers were registered only in the completion callback of
        // subscribeEvents(). A fast subscription already polls and emits while a slow one is
        // still pending - those events had no listener and were lost for good.
        it('processes an event that arrives before all subscriptions are done', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            let emitted = false;
            const slowSubscribes = [];
            dss.pollChannel = () => {};
            dss.requestAsync = async (dssClass, dssFunction, params) => {
                if (dssFunction !== 'subscribe') {
                    return { ok: true };
                }
                if (params.name === 'callScene') {
                    // The fast subscription immediately delivers an event
                    if (!emitted) {
                        emitted = true;
                        setImmediate(() =>
                            dss.emit('callScene', {
                                name: 'callScene',
                                source: { isGroup: true },
                                properties: { zoneID: '5', groupID: '1', sceneID: '17' },
                            }),
                        );
                    }
                    return { ok: true };
                }
                // Every other subscription is slow and only finishes at the end of the test
                await new Promise(resolve => slowSubscribes.push(resolve));
                return { ok: true };
            };

            const ctx = eventContext(dss);
            let earlyState;
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                expect(earlyState, 'the early event must be applied before all subscriptions are done').to.equal(true);
                dss.stop();
                done();
            });

            setTimeout(() => {
                earlyState = ctx.states['apartment.zones.5.groups.1.scenes.Preset2'];
                expect(earlyState, 'an early event must not be lost').to.equal(true);
                slowSubscribes.forEach(resolve => resolve());
            }, 30);
        });

        it('registers the handlers before the first subscription is sent', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            let listenersAtFirstSubscribe = -1;
            dss.pollChannel = () => {};
            dss.requestAsync = async (dssClass, dssFunction) => {
                if (dssFunction === 'subscribe' && listenersAtFirstSubscribe === -1) {
                    listenersAtFirstSubscribe = dss.listenerCount('callScene');
                }
                return { ok: true };
            };
            const ctx = eventContext(dss);
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                expect(listenersAtFirstSubscribe, 'callScene must already have a listener').to.be.above(0);
                dss.stop();
                done();
            });
        });

        it('registers no listener twice when called again', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.pollChannel = () => {};
            const ctx = eventContext(dss);
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                const afterFirst = dss.listenerCount('callScene');
                Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                    expect(dss.listenerCount('callScene'), 'no duplicated handlers').to.equal(afterFirst);
                    expect(afterFirst).to.equal(1);
                    dss.stop();
                    done();
                });
            });
        });
    });

    describe('scene fan-out to the devices', () => {
        function sceneContext(config) {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.pollChannel = () => {};
            const deviceEvents = [];
            const ctx = createContext({
                dss,
                config: Object.assign({ initializeOutputValues: true, usePresetValues: true }, config),
                dssStruct: {
                    // Room 5 with one device in the light group - the broadcast group 0 is
                    // never a key here, the DSS does not list devices in it
                    zoneDevices: { 5: { 1: ['dev1'], 2: ['dev2'] } },
                    stateMap: {
                        '5.1.scenes.0': 'apartment.0.5.1.scenes.Preset0',
                        '5.2.scenes.0': 'apartment.0.5.2.scenes.Preset0',
                        '0.0.scenes.0': 'apartment.scenes.Preset0',
                    },
                    dssObjects: {},
                    apartmentStructure: { zones: [{ id: 5 }] },
                },
            });
            dss.on('dev1', data => deviceEvents.push(['dev1', data.properties.sceneID]));
            dss.on('dev2', data => deviceEvents.push(['dev2', data.properties.sceneID]));
            return { ctx, dss, deviceEvents };
        }

        function callScene(dss, zoneID, groupID) {
            dss.emit('callScene', {
                name: 'callScene',
                source: { isGroup: true, isDevice: false, isApartment: false },
                properties: { zoneID, groupID, sceneID: '0', callOrigin: '-1' },
            });
        }

        // Regression: a scene for a whole room arrives with groupID "0". zoneDevices is only
        // keyed by the real device groups, so the fan-out found nothing and the forwarding
        // loop that runs afterwards is marked as "forwarded", which disabled it as well.
        // Result: brightness and shade position kept their old value forever.
        it('reaches every device of the room on a room wide scene (groupID 0)', done => {
            const { ctx, dss, deviceEvents } = sceneContext();
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            callScene(dss, '5', '0');
            setTimeout(() => {
                expect(deviceEvents.map(e => e[0]).sort(), 'both devices of the room must be refreshed').to.deep.equal([
                    'dev1',
                    'dev2',
                ]);
                dss.stop();
                done();
            }, 10);
        });

        it('still reaches exactly the devices of one group on a group scene', done => {
            const { ctx, dss, deviceEvents } = sceneContext();
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            callScene(dss, '5', '1');
            setTimeout(() => {
                expect(deviceEvents).to.deep.equal([['dev1', '0']]);
                dss.stop();
                done();
            }, 10);
        });

        it('delivers every device exactly once on a room wide scene', done => {
            const { ctx, dss, deviceEvents } = sceneContext();
            ctx.dssStruct.zoneDevices = { 5: { 1: ['dev1'], 2: ['dev1', 'dev2'], 8: ['dev1'] } };
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            callScene(dss, '5', '0');
            setTimeout(() => {
                const perDevice = {};
                deviceEvents.forEach(e => (perDevice[e[0]] = (perDevice[e[0]] || 0) + 1));
                expect(perDevice, 'a device in several groups must not be handled twice').to.deep.equal({
                    dev1: 1,
                    dev2: 1,
                });
                dss.stop();
                done();
            }, 10);
        });

        // Regression: the fan-out was gated on initializeOutputValues, but the device handlers
        // also apply the scene preset values, which is controlled by usePresetValues. With
        // reading switched off the preset values were silently dead too.
        it('reaches the devices even when initializeOutputValues is off', done => {
            const { ctx, dss, deviceEvents } = sceneContext({ initializeOutputValues: false });
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            callScene(dss, '5', '1');
            setTimeout(() => {
                expect(deviceEvents, 'the preset values must still be applied').to.deep.equal([['dev1', '0']]);
                dss.stop();
                done();
            }, 10);
        });

        it('does not fan out again for the forwarded frames', done => {
            const { ctx, dss, deviceEvents } = sceneContext();
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            callScene(dss, '5', '0');
            setTimeout(() => {
                expect(deviceEvents.length, 'exactly one event per device, not one per group').to.equal(2);
                dss.stop();
                done();
            }, 10);
        });
    });

    describe('button events', () => {
        function buttonContext() {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.pollChannel = () => {};
            const ctx = createContext({
                dss,
                dssStruct: {
                    dssObjects: {
                        'devices.m1.dev1.buttonClickType': { common: { type: 'number' } },
                        'devices.m1.dev1.buttonHoldCount': { common: { type: 'number' } },
                    },
                    stateMap: {
                        'dev1.0.button': 'devices.m1.dev1.button',
                        'dev1.0.buttonClickType': 'devices.m1.dev1.buttonClickType',
                        'dev1.0.buttonHoldCount': 'devices.m1.dev1.buttonHoldCount',
                    },
                    zoneDevices: {},
                    apartmentStructure: { zones: [] },
                },
            });
            return { ctx, dss };
        }

        // Regression: both states are declared as numbers, but the DSS sends strings and the
        // handler wrote them with setState instead of setDssState
        it('converts the DSS strings of a button click into numbers', done => {
            const { ctx, dss } = buttonContext();
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['buttonClick']);
            dss.emit('buttonClick', {
                name: 'buttonClick',
                source: { isDevice: true, dSUID: 'dev1' },
                properties: { clickType: '7', holdCount: '3' },
            });
            setTimeout(() => {
                expect(ctx.states['devices.m1.dev1.button']).to.equal(true);
                expect(ctx.states['devices.m1.dev1.buttonClickType'], 'must be the number 7').to.equal(7);
                expect(ctx.states['devices.m1.dev1.buttonHoldCount']).to.equal(3);
                dss.stop();
                done();
            }, 10);
        });

        it('keeps the click type 0 and the defaults working', done => {
            const { ctx, dss } = buttonContext();
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['buttonClick']);
            dss.emit('buttonClick', {
                name: 'buttonClick',
                source: { isDevice: true, dSUID: 'dev1' },
                properties: { clickType: 0 },
            });
            setTimeout(() => {
                expect(ctx.states['devices.m1.dev1.buttonClickType'], 'clickType 0 stays 0').to.equal(0);
                expect(ctx.states['devices.m1.dev1.buttonHoldCount'], 'default 0').to.equal(0);
                dss.stop();
                done();
            }, 10);
        });

        it('does not write anything when only the plain button state exists', done => {
            const { ctx, dss } = buttonContext();
            delete ctx.dssStruct.stateMap['dev1.0.buttonClickType'];
            delete ctx.dssStruct.stateMap['dev1.0.buttonHoldCount'];
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['buttonClick']);
            expect(() =>
                dss.emit('buttonClick', {
                    name: 'buttonClick',
                    source: { isDevice: true, dSUID: 'dev1' },
                    properties: { clickType: '7' },
                }),
            ).to.not.throw();
            setTimeout(() => {
                expect(ctx.states['devices.m1.dev1.button']).to.equal(true);
                expect(Object.keys(ctx.states), 'no write with an undefined id').to.deep.equal([
                    'devices.m1.dev1.button',
                ]);
                dss.stop();
                done();
            }, 10);
        });
    });

    describe('temperature operation mode', () => {
        // The room temperature control is switched through the scenes of group 48. The
        // readable OperationMode state has to follow every scene call.
        function tempContext() {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.pollChannel = () => {};
            const ctx = createContext({
                dss,
                dssStruct: {
                    zoneDevices: {},
                    dssObjects: {
                        'apartment.0.2.temperatureControl.OperationMode': { common: { type: 'number' } },
                    },
                    stateMap: {
                        '2.48.scenes.1': 'apartment.0.2.48.scenes.HeatingComfort',
                        '2.48.operationMode': 'apartment.0.2.temperatureControl.OperationMode',
                    },
                    apartmentStructure: { zones: [] },
                },
            });
            return { ctx, dss };
        }

        it('follows a scene call of group 48', done => {
            const { ctx, dss } = tempContext();
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            dss.emit('callScene', {
                name: 'callScene',
                source: { isGroup: true },
                properties: { zoneID: '2', groupID: '48', sceneID: '1', callOrigin: '-1' },
            });
            setTimeout(() => {
                expect(ctx.states['apartment.0.2.48.scenes.HeatingComfort'], 'the scene itself').to.equal(true);
                expect(
                    ctx.states['apartment.0.2.temperatureControl.OperationMode'],
                    'the readable mode must follow as a number',
                ).to.equal(1);
                dss.stop();
                done();
            }, 10);
        });

        it('does not touch the mode for a scene of another group', done => {
            const { ctx, dss } = tempContext();
            ctx.dssStruct.stateMap['2.1.scenes.1'] = 'apartment.0.2.1.scenes.Preset1';
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            dss.emit('callScene', {
                name: 'callScene',
                source: { isGroup: true },
                properties: { zoneID: '2', groupID: '1', sceneID: '1', callOrigin: '-1' },
            });
            setTimeout(() => {
                expect(ctx.states['apartment.0.2.temperatureControl.OperationMode']).to.equal(undefined);
                dss.stop();
                done();
            }, 10);
        });

        it('survives a room without temperature control', done => {
            const { ctx, dss } = tempContext();
            delete ctx.dssStruct.stateMap['2.48.operationMode'];
            Digitalstrom.prototype.registerEventHandlers.call(ctx, ['callScene']);
            expect(() =>
                dss.emit('callScene', {
                    name: 'callScene',
                    source: { isGroup: true },
                    properties: { zoneID: '2', groupID: '48', sceneID: '1', callOrigin: '-1' },
                }),
            ).to.not.throw();
            setTimeout(() => {
                dss.stop();
                done();
            }, 10);
        });
    });

    describe('scene resync after the subscription', () => {
        function resyncContext(dss, answers) {
            return createContext({
                dss,
                lastScenes: { 5.1: 17, 5.2: 0, dev1abcdef: 5 },
                dssQueue: {
                    /** @type {Array<{key: string, prio: string}>} */
                    asked: [],
                    pushQueryQueue(circuit, entry, prio, callback) {
                        const key = `${entry.params.id}.${entry.params.groupID}`;
                        this.asked.push({ key, prio });
                        setImmediate(() => callback(null, { ok: true, result: { scene: answers[key] } }));
                    },
                },
                dssStruct: {
                    stateMap: {
                        '5.1.scenes.17': 'apartment.zones.5.groups.1.scenes.Preset2',
                        '5.1.scenes.5': 'apartment.zones.5.groups.1.scenes.Preset1',
                        '5.2.scenes.0': 'apartment.zones.5.groups.2.scenes.Preset0',
                    },
                    zoneDevices: {},
                    dssObjects: {},
                    apartmentStructure: { zones: [] },
                },
            });
        }

        it('applies a scene that changed while the adapter was starting', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.pollChannel = () => {};
            const ctx = resyncContext(dss, { 5.1: 5, 5.2: 0 });
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                Digitalstrom.prototype.resyncSceneStates.call(ctx, () => {
                    expect(
                        ctx.states['apartment.zones.5.groups.1.scenes.Preset1'],
                        'the scene missed during the startup must be applied',
                    ).to.equal(true);
                    expect(
                        ctx.states['apartment.zones.5.groups.1.scenes.Preset2'],
                        'and the old one must be released',
                    ).to.equal(false);
                    expect(ctx.lastScenes['5.1'], 'the bookkeeping must follow').to.equal('5');
                    dss.stop();
                    done();
                });
            });
        });

        it('changes nothing when no scene changed', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            dss.requestAsync = async () => ({ ok: true });
            dss.pollChannel = () => {};
            const ctx = resyncContext(dss, { 5.1: 17, 5.2: 0 });
            Digitalstrom.prototype.initializeSubscriptions.call(ctx, () => {
                Digitalstrom.prototype.resyncSceneStates.call(ctx, () => {
                    expect(ctx.states, 'an unchanged scene must not produce a write').to.deep.equal({});
                    dss.stop();
                    done();
                });
            });
        });

        it('only asks for zone groups, not for devices, and only with low priority', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            const ctx = resyncContext(dss, { 5.1: 17, 5.2: 0 });
            Digitalstrom.prototype.resyncSceneStates.call(ctx, () => {
                expect(ctx.dssQueue.asked.map(a => a.key).sort()).to.deep.equal(['5.1', '5.2']);
                ctx.dssQueue.asked.forEach(a => expect(a.prio, 'must never delay a user command').to.equal('low'));
                dss.stop();
                done();
            });
        });

        it('does nothing while the adapter is stopping', done => {
            const dss = new DSS({ host: 'localhost', appToken: 'app', logger: silentLog });
            const ctx = resyncContext(dss, {});
            ctx.stopping = true;
            Digitalstrom.prototype.resyncSceneStates.call(ctx, () => {
                expect(ctx.dssQueue.asked, 'no request during the unload').to.deep.equal([]);
                dss.stop();
                done();
            });
        });
    });
});
