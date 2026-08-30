const { expect } = require('chai');

const DSSSmartHome = require('../lib/dssSmartHome');
const createMockSmartHome = require('./lib/mockSmartHome');

const silentLogger = { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('Smart Home API client', function () {
    this.timeout(15000);

    let mock;
    let client;

    beforeEach(async () => {
        mock = createMockSmartHome();
        await mock.listen();
    });

    afterEach(async () => {
        client && client.stop();
        client = null;
        await mock.close();
    });

    /**
     * @param {object} [overrides]
     * @returns {DSSSmartHome}
     */
    function createClient(overrides) {
        return new DSSSmartHome({
            host: mock.baseUrl(),
            apiKey: createMockSmartHome.API_KEY,
            logger: silentLogger,
            notificationPort: mock.port(),
            notificationDebounce: 60,
            notificationMaxDelay: 300,
            ...overrides,
        });
    }

    describe('reading', () => {
        it('unwraps the data envelope of the answer', async () => {
            client = createClient();
            const apartment = await client.getApartment();
            expect(apartment.type).to.equal('apartment');
            expect(apartment.included.dsDevices).to.have.lengthOf(1);
        });

        it('asks for every include in one request', async () => {
            client = createClient();
            await client.getApartment();
            const call = mock.pathsCalled('/api/v1/apartment')[0];
            expect(call.query.include).to.contain('dsDevices');
            expect(call.query.include).to.contain('functionBlocks');
            expect(call.query.include).to.contain('meterings');
            expect(mock.requests, 'exactly one request for the whole structure').to.have.lengthOf(1);
        });

        it('reads the status including the user defined states', async () => {
            client = createClient();
            await client.getApartmentStatus();
            const call = mock.pathsCalled('/api/v1/apartment/status')[0];
            expect(call.query.include).to.contain('userDefinedStates');
        });

        it('reads a single zone instead of the whole flat', async () => {
            client = createClient();
            const zone = await client.getZoneStatus(2);
            expect(zone.type).to.equal('zoneStatus');
            expect(mock.requests[0].path).to.equal('/api/v1/apartment/zones/2/status');
        });

        it('reads all meter values with one request', async () => {
            client = createClient();
            const values = await client.getMeteringValues();
            expect(values.values[0].attributes.value).to.equal(139);
            expect(mock.requests, 'one request for all meters').to.have.lengthOf(1);
        });
    });

    describe('errors', () => {
        it('reports the http status of a failed request', async () => {
            client = createClient({ apiKey: 'wrong' });
            /** @type {any} */
            let caught = null;
            try {
                await client.getApartment();
            } catch (err) {
                caught = err;
            }
            expect(caught, 'the request must fail').to.not.equal(null);
            expect(caught.status).to.equal(401);
            expect(caught.message).to.contain('HTTP 401');
        });

        it('reports a broken json answer instead of throwing somewhere else', async () => {
            client = createClient();
            /** @type {any} */
            let caught = null;
            try {
                await client.request('GET', '/api/v1/broken');
            } catch (err) {
                caught = err;
            }
            expect(caught).to.not.equal(null);
            expect(caught.message).to.contain('Invalid JSON');
        });

        it('sends no request after stop()', async () => {
            client = createClient();
            client.stop();
            /** @type {any} */
            let caught = null;
            try {
                await client.getApartment();
            } catch (err) {
                caught = err;
            }
            expect(caught).to.not.equal(null);
            expect(caught.shutdown, 'marked as shutdown').to.equal(true);
            expect(mock.requests, 'nothing reached the server').to.have.lengthOf(0);
        });
    });

    describe('writing', () => {
        it('sets an output as a json patch', async () => {
            client = createClient();
            await client.setOutputValue('dev1', 'dev1', 'brightness', 42);
            const call = mock.pathsCalled('/api/v1/apartment/dsDevices/dev1/status')[0];
            expect(call.method).to.equal('PATCH');
            expect(call.body).to.deep.equal([
                { op: 'replace', path: '/functionBlocks/dev1/outputs/brightness/value', value: '42' },
            ]);
        });

        it('sets the set point of a zone', async () => {
            client = createClient();
            await client.setZoneSetpoint(2, 21.5);
            const call = mock.pathsCalled('/api/v1/apartment/zones/2/status')[0];
            expect(call.method).to.equal('PATCH');
            expect(call.body).to.deep.equal([
                { op: 'replace', path: '/applications/temperature/setpoint', value: 21.5 },
            ]);
        });

        it('invokes a scenario by its id', async () => {
            client = createClient();
            await client.invokeScenario('applicationZone-z2-g1-s18');
            expect(mock.requests[0].path).to.equal('/api/v1/apartment/scenarios/applicationZone-z2-g1-s18/invoke');
            expect(mock.requests[0].method).to.equal('POST');
        });

        it('accepts an empty answer of a write', async () => {
            client = createClient();
            const answer = await client.setOutputValue('dev1', 'dev1', 'brightness', 0);
            expect(answer).to.equal(null);
        });
    });

    describe('notifications', () => {
        it('connects and sends the signalr handshake with the record separator', async () => {
            client = createClient();
            await client.startNotifications();
            await delay(100);
            expect(mock.openSockets(), 'one open notification socket').to.equal(1);
        });

        // A moving blind fires several notifications per second, and every one of them
        // would cost a 59 KB status read on a real installation.
        it('collects a burst of notifications into a single event', async () => {
            client = createClient();
            const seen = [];
            client.on('statusChanged', types => seen.push(types));
            await client.startNotifications();
            await delay(80);

            for (let i = 0; i < 5; i++) {
                mock.notify('apartmentStatusChanged');
                await delay(10);
            }
            await delay(200);

            expect(seen, 'five notifications become one event').to.have.lengthOf(1);
            expect(seen[0]).to.deep.equal(['apartmentStatusChanged']);
        });

        it('reports at the latest after the maximum delay during a continuous stream', async () => {
            client = createClient({ notificationDebounce: 200, notificationMaxDelay: 300 });
            const seen = [];
            client.on('statusChanged', () => seen.push(Date.now()));
            await client.startNotifications();
            await delay(80);

            // Never a quiet moment longer than the debounce, so only the maximum delay helps
            const started = Date.now();
            while (Date.now() - started < 700) {
                mock.notify('apartmentStatusChanged');
                await delay(50);
            }
            await delay(100);

            expect(seen.length, 'the stream must not silence the client').to.be.at.least(2);
        });

        it('separates a structure change from a status change', async () => {
            client = createClient();
            const events = [];
            client.on('statusChanged', () => events.push('status'));
            client.on('structureChanged', () => events.push('structure'));
            await client.startNotifications();
            await delay(80);

            mock.notify('apartmentStructureChanged');
            await delay(200);

            expect(events).to.deep.equal(['structure']);
        });

        it('reconnects after the dSS dropped the connection', async () => {
            client = createClient();
            let connects = 0;
            client.on('notificationConnected', () => connects++);
            await client.startNotifications();
            await delay(80);
            expect(connects).to.equal(1);

            mock.dropSockets();
            // The first backoff step is two seconds
            await delay(2600);

            expect(connects, 'the client comes back on its own').to.be.at.least(2);
            expect(mock.openSockets()).to.equal(1);
        });

        it('opens nothing more after stop()', async () => {
            client = createClient();
            await client.startNotifications();
            await delay(80);
            client.stop();
            mock.dropSockets();
            await delay(2600);
            expect(mock.openSockets(), 'no reconnect after stop').to.equal(0);
        });
    });

    describe('api key', () => {
        it('creates the key from an existing app token, without a password', async () => {
            const key = await DSSSmartHome.createApiKey({
                host: mock.baseUrl(),
                appToken: 'existing-app-token',
                logger: silentLogger,
            });
            expect(key).to.equal('the-new-key');

            const login = mock.pathsCalled('/json/system/loginApplication');
            expect(login, 'the app token becomes a session').to.have.lengthOf(1);
            expect(login[0].query.loginToken).to.equal('existing-app-token');

            const created = mock.pathsCalled('/api/v1/apartment/applicationTokens');
            expect(created, 'exactly one token is created').to.have.lengthOf(1);
            expect(created[0].query.token, 'the session authorizes the creation').to.equal('session-token');
            expect(created[0].body.data.attributes.name).to.equal('ioBroker.digitalstrom');
        });
    });
});
