const { expect } = require('chai');
const proxyquire = require('proxyquire');
const ObjectHelper = require('@apollon/iobroker-tools');

const { Digitalstrom } = proxyquire('../main', {
    '@iobroker/adapter-core': {
        Adapter: class FakeAdapter {
            on() {}
        },
        '@noCallThru': true,
    },
});

const silentLog = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * Minimal adapter double that records which namespace an object write ended up on.
 *
 * @param {string} namespace
 * @param {Array} sink
 * @returns {object} fake adapter
 */
function fakeAdapter(namespace, sink) {
    return {
        namespace,
        log: silentLog,
        getObject: (id, cb) => cb(null, null),
        setObject: (id, obj, cb) => {
            sink.push(`${namespace}/${id}`);
            cb && cb();
        },
        extendObject: (id, obj, cb) => {
            sink.push(`${namespace}/ext/${id}`);
            cb && cb();
        },
        setState: (id, value, ack, cb) => {
            sink.push(`${namespace}/state/${id}`);
            cb && cb();
        },
        getAdapterObjects: cb => cb({}),
    };
}

const stateObject = { type: 'state', common: { type: 'boolean', role: 'switch' } };

describe('objectHelper instance isolation', () => {
    it('the shared helper of the dependency really is a singleton', () => {
        // Documents why the private copy is needed - if this ever changes, revisit
        expect(ObjectHelper.objectHelper).to.equal(ObjectHelper.objectHelper);
        expect(ObjectHelper.objectHelper.init).to.be.a('function');
    });

    it('createObjectHelper returns a separate helper per call', () => {
        const first = Digitalstrom.createObjectHelper(silentLog);
        const second = Digitalstrom.createObjectHelper(silentLog);
        expect(first).to.not.equal(second);
        expect(first).to.not.equal(ObjectHelper.objectHelper);
        expect(first.setOrUpdateObject).to.be.a('function');
    });

    it('does not disturb the module cache of other consumers', () => {
        const before = require('@apollon/iobroker-tools').objectHelper;
        Digitalstrom.createObjectHelper(silentLog);
        expect(require('@apollon/iobroker-tools').objectHelper).to.equal(before);
    });

    it('writes of instance 0 stay on instance 0 after instance 1 was initialized', done => {
        const writes0 = [];
        const writes1 = [];
        const helper0 = Digitalstrom.createObjectHelper(silentLog);
        const helper1 = Digitalstrom.createObjectHelper(silentLog);

        helper0.init(fakeAdapter('digitalstrom.0', writes0));
        // instance 1 starts afterwards - with the shared singleton it would take over
        helper1.init(fakeAdapter('digitalstrom.1', writes1));

        helper0.setOrUpdateObject('devices.a.state', stateObject, ['name'], true);
        helper0.processObjectQueue(() => {
            expect(writes0, 'the write must stay on its own instance').to.include('digitalstrom.0/devices.a.state');
            expect(writes1, 'nothing may end up on the other instance').to.deep.equal([]);
            done();
        });
    });

    it('keeps the known objects of the instances apart', done => {
        const helper0 = Digitalstrom.createObjectHelper(silentLog);
        const helper1 = Digitalstrom.createObjectHelper(silentLog);
        const adapter0 = fakeAdapter('digitalstrom.0', []);
        const adapter1 = fakeAdapter('digitalstrom.1', []);
        // clearAdditionalObjects() deletes everything listed in existingStates - with a
        // shared helper instance 0 would see the objects of instance 1 here
        adapter0.getAdapterObjects = cb => cb({ 'digitalstrom.0.devices.own': {} });
        adapter1.getAdapterObjects = cb => cb({ 'digitalstrom.1.devices.other': {} });

        helper0.init(adapter0);
        helper1.init(adapter1);
        helper0.loadExistingObjects(() => {
            helper1.loadExistingObjects(() => {
                expect(Object.keys(helper0.existingStates)).to.deep.equal(['devices.own']);
                expect(Object.keys(helper1.existingStates)).to.deep.equal(['devices.other']);
                done();
            });
        });
    });

    it('falls back to the shared helper with a warning when the private copy fails', () => {
        const warnings = [];
        // Every require.resolve goes through Module._resolveFilename, so this also affects
        // the call inside main.js. Simulates a future version that hides the subpath.
        // _resolveFilename is an internal node API without public typings
        const Module = /** @type {any} */ (require('node:module'));
        const originalResolveFilename = Module._resolveFilename;
        Module._resolveFilename = function (request, ...rest) {
            if (request === '@apollon/iobroker-tools/lib/objectHelper') {
                /** @type {import('../lib/configUtils').AdapterError} */
                const err = new Error(`Package subpath not exported: ${request}`);
                err.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
                throw err;
            }
            return originalResolveFilename.call(this, request, ...rest);
        };
        try {
            const helper = Digitalstrom.createObjectHelper({ warn: msg => warnings.push(String(msg)) });
            expect(helper, 'the adapter must still work').to.equal(ObjectHelper.objectHelper);
            expect(warnings).to.have.lengthOf(1);
            expect(warnings[0]).to.contain('compact');
        } finally {
            Module._resolveFilename = originalResolveFilename;
        }
    });
});
