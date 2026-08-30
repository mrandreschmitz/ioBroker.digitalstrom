#!/usr/bin/env node
/**
 * Read-only Probe fuer die neue digitalSTROM "Smart Home API" (/api/v1) eines dSS.
 *
 * Das Skript beantwortet die Frage, ob und wie vollstaendig der Adapter auf die neue
 * REST-API plus Notification-Websocket umgebaut werden kann. Es schreibt alle Antworten
 * als JSON in ein Ausgabeverzeichnis, damit das Mapping danach offline entworfen werden kann.
 *
 * Ausser dem optionalen Anlegen eines Application Tokens (--create-token) veraendert
 * das Skript nichts auf dem dSS - es liest nur.
 *
 * Benutzung:
 *   DSS_PASSWORD=xxx node scripts/probe-smarthome-api.js --host 192.168.1.10 --create-token
 *   node scripts/probe-smarthome-api.js --host 192.168.1.10 --token <apiKey> --seconds 120
 *
 * Optionen:
 *   --host <ip|name>     dSS Adresse (Pflicht)
 *   --port <n>           HTTPS Port der REST-API (Default 8080)
 *   --ws-port <n>        Port des Notification-Websockets (Default 8090)
 *   --token <apiKey>     bereits vorhandener API-Key (Bearer)
 *   --create-token       legt per Login einen neuen Application Token an und nutzt ihn
 *   --user <name>        Login-Benutzer fuer --create-token (Default dssadmin)
 *   --seconds <n>        Dauer des Websocket-Mitschnitts (Default 60, 0 = ueberspringen)
 *   --out <dir>          Ausgabeverzeichnis (Default ./ds-probe)
 *   --old-api            zusaetzlich system/version und apartment/getStructure der alten API
 *
 * Das Passwort wird ausschliesslich ueber die Umgebungsvariable DSS_PASSWORD gelesen und
 * niemals geloggt oder gespeichert.
 */

const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RECORD_SEPARATOR = String.fromCharCode(0x1e);

/**
 * @param {unknown} err
 * @returns {string} lesbare Fehlermeldung
 */
function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
    const args = {
        port: 8080,
        wsPort: 8090,
        seconds: 60,
        out: path.join(process.cwd(), 'ds-probe'),
        user: 'dssadmin',
        createToken: false,
        oldApi: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const key = argv[i];
        const next = () => argv[++i];
        switch (key) {
            case '--host':
                args.host = next();
                break;
            case '--port':
                args.port = Number(next());
                break;
            case '--ws-port':
                args.wsPort = Number(next());
                break;
            case '--token':
                args.token = next();
                break;
            case '--create-token':
                args.createToken = true;
                break;
            case '--user':
                args.user = next();
                break;
            case '--seconds':
                args.seconds = Number(next());
                break;
            case '--out':
                args.out = next();
                break;
            case '--old-api':
                args.oldApi = true;
                break;
            case '--help':
            case '-h':
                args.help = true;
                break;
            default:
                console.error(`Unbekannte Option: ${key}`);
                process.exit(1);
        }
    }
    return args;
}

/* ------------------------------------------------------------------ http */

function request(options, body) {
    return new Promise((resolve, reject) => {
        const transport = options.protocol === 'http:' ? http : https;
        const req = transport.request({ ...options, rejectUnauthorized: false, timeout: 30000 }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                if (text) {
                    try {
                        json = JSON.parse(text);
                    } catch {
                        /* keine JSON Antwort, text bleibt erhalten */
                    }
                }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('timeout', () => req.destroy(new Error('Timeout')));
        req.on('error', reject);
        if (body !== undefined) {
            req.end(body);
        } else {
            req.end();
        }
    });
}

function apiUrl(args, apiPath, params) {
    const url = new URL(`https://${args.host}:${args.port}${apiPath}`);
    for (const [key, value] of Object.entries(params || {})) {
        url.searchParams.set(key, value);
    }
    return url;
}

async function get(args, apiPath, params) {
    const url = apiUrl(args, apiPath, params);
    return request({
        protocol: 'https:',
        host: args.host,
        port: args.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: args.token ? { Authorization: `Bearer ${args.token}` } : {},
    });
}

/* ------------------------------------------------------------ websocket */

/**
 * Minimaler Websocket-Client. Nur so viel, wie die Probe braucht: Handshake mit
 * eigenem Authorization-Header, Textframes lesen und schreiben, Ping beantworten.
 */
class MiniWebsocket {
    constructor(host, port, wsPath, headers, secure) {
        this.host = host;
        this.port = port;
        this.wsPath = wsPath;
        this.headers = headers || {};
        this.secure = !!secure;
        this.buffer = Buffer.alloc(0);
        /** @type {import('node:net').Socket|null} */
        this.socket = null;
        /** @type {(text: string) => void} */
        this.onMessage = () => {};
        /** @type {(err: Error) => void} */
        this.onError = () => {};
        this.handshakeDone = false;
    }

    connect() {
        return new Promise((resolve, reject) => {
            const key = crypto.randomBytes(16).toString('base64');
            const connectOptions = { host: this.host, port: this.port, rejectUnauthorized: false };
            const socket = this.secure ? tls.connect(connectOptions) : net.connect(connectOptions);
            this.socket = socket;
            socket.setTimeout(20000, () => {
                if (!this.handshakeDone) {
                    // Der close-Handler unten weist die Promise ab
                    socket.destroy();
                }
            });
            socket.once(this.secure ? 'secureConnect' : 'connect', () => {
                const headerLines = [
                    `GET ${this.wsPath} HTTP/1.1`,
                    `Host: ${this.host}:${this.port}`,
                    'Upgrade: websocket',
                    'Connection: Upgrade',
                    `Sec-WebSocket-Key: ${key}`,
                    'Sec-WebSocket-Version: 13',
                    ...Object.entries(this.headers).map(([name, value]) => `${name}: ${value}`),
                    '',
                    '',
                ];
                socket.write(headerLines.join('\r\n'));
            });
            socket.on('error', err => {
                if (this.handshakeDone) {
                    this.onError(err);
                } else {
                    reject(err);
                }
            });
            socket.on('close', () => {
                if (!this.handshakeDone) {
                    reject(new Error('Verbindung wurde geschlossen'));
                }
            });
            socket.on('data', chunk => {
                this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
                if (!this.handshakeDone) {
                    const end = this.buffer.indexOf('\r\n\r\n');
                    if (end === -1) {
                        return;
                    }
                    const head = this.buffer.subarray(0, end).toString('utf8');
                    this.buffer = this.buffer.subarray(end + 4);
                    if (!/^HTTP\/1\.1 101/.test(head)) {
                        return reject(new Error(`Handshake abgelehnt:\n${head}`));
                    }
                    this.handshakeDone = true;
                    socket.setTimeout(0);
                    resolve(head);
                }
                this.drainFrames();
            });
        });
    }

    drainFrames() {
        for (;;) {
            if (this.buffer.length < 2) {
                return;
            }
            const first = this.buffer[0];
            const second = this.buffer[1];
            const opcode = first & 0x0f;
            const masked = (second & 0x80) !== 0;
            let length = second & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (this.buffer.length < offset + 2) {
                    return;
                }
                length = this.buffer.readUInt16BE(offset);
                offset += 2;
            } else if (length === 127) {
                if (this.buffer.length < offset + 8) {
                    return;
                }
                length = Number(this.buffer.readBigUInt64BE(offset));
                offset += 8;
            }
            let maskKey = null;
            if (masked) {
                if (this.buffer.length < offset + 4) {
                    return;
                }
                maskKey = this.buffer.subarray(offset, offset + 4);
                offset += 4;
            }
            if (this.buffer.length < offset + length) {
                return;
            }
            let payload = this.buffer.subarray(offset, offset + length);
            this.buffer = this.buffer.subarray(offset + length);
            if (maskKey) {
                payload = Buffer.from(payload.map((byte, idx) => byte ^ maskKey[idx % 4]));
            }
            if (opcode === 0x8) {
                this.close();
                return;
            }
            if (opcode === 0x9) {
                this.sendFrame(payload, 0x0a);
                continue;
            }
            if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
                this.onMessage(payload.toString('utf8'));
            }
        }
    }

    sendFrame(payload, opcode) {
        const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
        const maskKey = crypto.randomBytes(4);
        const header = [0x80 | opcode];
        if (data.length < 126) {
            header.push(0x80 | data.length);
        } else if (data.length < 65536) {
            header.push(0x80 | 126, (data.length >> 8) & 0xff, data.length & 0xff);
        } else {
            header.push(
                0x80 | 127,
                0,
                0,
                0,
                0,
                (data.length >>> 24) & 0xff,
                (data.length >>> 16) & 0xff,
                (data.length >>> 8) & 0xff,
                data.length & 0xff,
            );
        }
        const masked = Buffer.from(data.map((byte, idx) => byte ^ maskKey[idx % 4]));
        if (!this.socket) {
            return;
        }
        this.socket.write(Buffer.concat([Buffer.from(header), maskKey, masked]));
    }

    send(text) {
        this.sendFrame(Buffer.from(text, 'utf8'), 0x1);
    }

    close() {
        try {
            this.socket && this.socket.destroy();
        } catch {
            /* ignorieren */
        }
    }
}

/* ----------------------------------------------------------------- probe */

function save(outDir, name, data) {
    const file = path.join(outDir, `${name}.json`);
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    return file;
}

function countDeep(value) {
    return Array.isArray(value) ? value.length : 0;
}

async function createApplicationToken(args) {
    const password = process.env.DSS_PASSWORD;
    if (!password) {
        throw new Error('DSS_PASSWORD ist nicht gesetzt - fuer --create-token noetig');
    }
    const loginUrl = apiUrl(args, '/json/system/login', { user: args.user, password });
    const login = await request({
        protocol: 'https:',
        host: args.host,
        port: args.port,
        path: `${loginUrl.pathname}${loginUrl.search}`,
        method: 'GET',
    });
    if (!login.json || !login.json.ok || !login.json.result || !login.json.result.token) {
        throw new Error(`Login fehlgeschlagen (HTTP ${login.status}): ${login.json ? login.json.message : login.text}`);
    }
    const sessionToken = login.json.result.token;
    const body = JSON.stringify({
        data: { type: 'applicationToken', attributes: { name: 'ioBroker.digitalstrom probe' } },
    });
    const tokenUrl = apiUrl(args, '/api/v1/apartment/applicationTokens', { token: sessionToken });
    const created = await request(
        {
            protocol: 'https:',
            host: args.host,
            port: args.port,
            path: `${tokenUrl.pathname}${tokenUrl.search}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        body,
    );
    if (created.status !== 201) {
        throw new Error(`Application Token nicht angelegt (HTTP ${created.status}): ${created.text || '-'}`);
    }
    const location = created.headers.location || '';
    const apiKey = location.split('/').filter(Boolean).pop();
    if (!apiKey) {
        throw new Error(`Antwort ohne Location-Header: ${JSON.stringify(created.headers)}`);
    }
    return apiKey;
}

async function probeEndpoints(args, outDir) {
    const endpoints = [
        {
            name: 'apartment',
            path: '/api/v1/apartment',
            params: {
                include:
                    'installation,dsDevices,submodules,functionBlocks,zones,clusters,applications,dsServer,controllers,apiRevision,meterings',
            },
        },
        { name: 'apartment-status', path: '/api/v1/apartment/status', params: { include: 'dsDevices,zones' } },
        { name: 'zones', path: '/api/v1/apartment/zones' },
        { name: 'zones-status', path: '/api/v1/apartment/zones/status' },
        { name: 'dsDevices', path: '/api/v1/apartment/dsDevices' },
        { name: 'dsDevices-status', path: '/api/v1/apartment/dsDevices/status' },
        { name: 'submodules', path: '/api/v1/apartment/submodules' },
        { name: 'functionBlocks', path: '/api/v1/apartment/functionBlocks' },
        { name: 'scenarios', path: '/api/v1/apartment/scenarios' },
        { name: 'meterings', path: '/api/v1/apartment/meterings' },
        { name: 'meterings-values', path: '/api/v1/apartment/meterings/values' },
        { name: 'controllers', path: '/api/v1/apartment/controllers' },
        { name: 'clusters', path: '/api/v1/apartment/clusters' },
        { name: 'userDefinedStates', path: '/api/v1/apartment/userDefinedStates' },
    ];

    const results = [];
    for (const endpoint of endpoints) {
        const started = Date.now();
        let res;
        try {
            res = await get(args, endpoint.path, endpoint.params);
        } catch (err) {
            const message = errorText(err);
            results.push({ name: endpoint.name, path: endpoint.path, status: 'ERROR', error: message });
            console.log(`  ${endpoint.name.padEnd(20)} FEHLER  ${message}`);
            continue;
        }
        const ms = Date.now() - started;
        const bytes = Buffer.byteLength(res.text || '');
        if (res.status === 200 && res.json) {
            save(outDir, endpoint.name, res.json);
        }
        results.push({ name: endpoint.name, path: endpoint.path, status: res.status, ms, bytes });
        console.log(
            `  ${endpoint.name.padEnd(20)} HTTP ${res.status}  ${String(ms).padStart(5)} ms  ${String(bytes).padStart(8)} Bytes`,
        );
    }
    return results;
}

function summarize(outDir) {
    const read = name => {
        const file = path.join(outDir, `${name}.json`);
        if (!fs.existsSync(file)) {
            return null;
        }
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return null;
        }
    };

    const apartment = read('apartment');
    const status = read('apartment-status');
    const scenarios = read('scenarios');
    const meterings = read('meterings');

    console.log('\n--- Inhalt ---');
    if (apartment && apartment.data && apartment.data.included) {
        const included = apartment.data.included;
        console.log(`  Zonen            : ${countDeep(included.zones)}`);
        console.log(`  dS-Geraete       : ${countDeep(included.dsDevices)}`);
        console.log(`  Submodule        : ${countDeep(included.submodules)}`);
        console.log(`  FunctionBlocks   : ${countDeep(included.functionBlocks)}`);
        console.log(`  Controller/dSM   : ${countDeep(included.controllers)}`);
        console.log(`  Meterings        : ${countDeep(included.meterings)}`);
        const functionBlocks = included.functionBlocks || [];
        const outputs = functionBlocks.flatMap(fb => (fb.attributes && fb.attributes.outputs) || []);
        const outputTypes = [...new Set(outputs.map(o => o.attributes && o.attributes.type).filter(Boolean))];
        console.log(`  Outputs gesamt   : ${outputs.length}`);
        console.log(`  Output-Typen     : ${outputTypes.join(', ') || '-'}`);
        console.log(
            `  SensorInputs     : ${functionBlocks.flatMap(fb => (fb.attributes && fb.attributes.sensorInputs) || []).length}`,
        );
        console.log(
            `  ButtonInputs     : ${functionBlocks.flatMap(fb => (fb.attributes && fb.attributes.buttonInputs) || []).length}`,
        );
        const applications = new Set();
        for (const zone of included.zones || []) {
            const attributes = zone.attributes || {};
            for (const app of attributes.applicationTypes || []) {
                applications.add(app);
            }
            for (const app of attributes.applications || []) {
                applications.add(typeof app === 'string' ? app : app && app.id);
            }
        }
        console.log(`  Applications     : ${[...applications].filter(Boolean).join(', ') || '-'}`);
    } else {
        console.log('  Kein verwertbares apartment.json - neue API vermutlich nicht verfuegbar.');
    }

    if (status && status.data) {
        console.log(`  Apartment-Status : ${Object.keys(status.data.attributes || {}).join(', ') || '-'}`);
        const zones = (status.data.included && status.data.included.zones) || [];
        const zoneWithTemperature = zones.find(zone => JSON.stringify(zone).includes('temperature'));
        console.log(`  Heizung im Status: ${zoneWithTemperature ? 'ja' : 'nicht gefunden'}`);
        const devices = (status.data.included && status.data.included.dsDevices) || [];
        const withStates = devices.filter(device => {
            const states = device.attributes && device.attributes.states;
            return Array.isArray(states) && states.length;
        });
        console.log(`  Geraete m. States: ${withStates.length} von ${devices.length}`);
    }

    if (scenarios && scenarios.data) {
        const list = Array.isArray(scenarios.data) ? scenarios.data : scenarios.data.scenarios || [];
        console.log(`  Szenarien        : ${countDeep(list)}`);
    }
    if (meterings && meterings.data) {
        const list = meterings.data.meterings || meterings.data;
        console.log(`  Metering-Punkte  : ${Array.isArray(list) ? list.length : '-'}`);
    }
}

async function probeWebsocket(args, outDir) {
    if (!args.seconds) {
        console.log('\n--- Websocket uebersprungen (--seconds 0) ---');
        return;
    }
    console.log(`\n--- Notification-Websocket (${args.seconds}s Mitschnitt) ---`);
    console.log('  Bitte waehrenddessen etwas schalten: Taster druecken, Licht dimmen, Rollo fahren.');

    const attempts = [
        { port: args.wsPort, secure: false, label: `ws://${args.host}:${args.wsPort}` },
        { port: args.wsPort, secure: true, label: `wss://${args.host}:${args.wsPort}` },
        { port: args.port, secure: true, label: `wss://${args.host}:${args.port}` },
    ];

    for (const attempt of attempts) {
        const ws = new MiniWebsocket(
            args.host,
            attempt.port,
            '/api/v1/apartment/notifications',
            { Authorization: `Bearer ${args.token}` },
            attempt.secure,
        );
        const messages = [];
        ws.onMessage = text => {
            const stamp = new Date().toISOString();
            messages.push({ stamp, text });
            console.log(`  [${stamp}] ${text.slice(0, 500)}`);
        };
        try {
            await ws.connect();
        } catch (err) {
            console.log(`  ${attempt.label} nicht erreichbar: ${errorText(err)}`);
            ws.close();
            continue;
        }
        console.log(`  verbunden ueber ${attempt.label}`);
        const handshake = JSON.stringify({ protocol: 'json', version: 1 });
        ws.send(handshake);
        await new Promise(resolve => setTimeout(resolve, 5000));
        if (!messages.length) {
            // Variante mit SignalR-Record-Separator, falls der dSS das Framing erwartet
            console.log('  keine Antwort, versuche Handshake mit Record-Separator');
            ws.send(handshake + RECORD_SEPARATOR);
        }
        await new Promise(resolve => setTimeout(resolve, Math.max(0, args.seconds - 5) * 1000));
        ws.close();
        save(outDir, 'notifications', messages);
        console.log(`  ${messages.length} Nachricht(en) empfangen -> notifications.json`);
        return;
    }
    console.log('  Kein Websocket erreichbar.');
}

async function probeOldApi(args, outDir) {
    console.log('\n--- Alte JSON-API zum Vergleich ---');
    const password = process.env.DSS_PASSWORD;
    if (!password) {
        console.log('  uebersprungen (DSS_PASSWORD nicht gesetzt)');
        return;
    }
    const loginUrl = apiUrl(args, '/json/system/login', { user: args.user, password });
    const login = await request({
        protocol: 'https:',
        host: args.host,
        port: args.port,
        path: `${loginUrl.pathname}${loginUrl.search}`,
        method: 'GET',
    });
    if (!login.json || !login.json.ok) {
        console.log('  Login fehlgeschlagen');
        return;
    }
    const sessionToken = login.json.result.token;
    for (const [name, apiPath] of [
        ['old-version', '/json/system/version'],
        ['old-structure', '/json/apartment/getStructure'],
    ]) {
        const url = apiUrl(args, apiPath, { token: sessionToken });
        const started = Date.now();
        const res = await request({
            protocol: 'https:',
            host: args.host,
            port: args.port,
            path: `${url.pathname}${url.search}`,
            method: 'GET',
        });
        const ms = Date.now() - started;
        const bytes = Buffer.byteLength(res.text || '');
        if (res.json) {
            save(outDir, name, res.json);
        }
        console.log(
            `  ${name.padEnd(20)} HTTP ${res.status}  ${String(ms).padStart(5)} ms  ${String(bytes).padStart(8)} Bytes`,
        );
        if (name === 'old-version' && res.json && res.json.result) {
            console.log(`  dSS Version: ${res.json.result.version || JSON.stringify(res.json.result)}`);
        }
    }
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help || !args.host) {
        const header = fs.readFileSync(__filename, 'utf8').split('*/')[0];
        console.log(header.replace(/^#![^\n]*\n/, '').replace(/^\/\*\*/, ''));
        process.exit(args.host ? 0 : 1);
    }
    fs.mkdirSync(args.out, { recursive: true });

    console.log(`dSS: ${args.host}:${args.port}, Ausgabe: ${args.out}\n`);

    if (!args.token && args.createToken) {
        console.log('--- Application Token anlegen ---');
        args.token = await createApplicationToken(args);
        console.log(`  API-Key: ${args.token}`);
        console.log('  Bitte notieren. Loeschbar im dSS unter System > Zugriffsberechtigung.\n');
        fs.writeFileSync(path.join(args.out, 'apikey.txt'), `${args.token}\n`, { mode: 0o600 });
    }
    if (!args.token) {
        console.error('Kein API-Key. Entweder --token <key> oder --create-token angeben.');
        process.exit(1);
    }

    console.log('--- REST-Endpunkte /api/v1 ---');
    const results = await probeEndpoints(args, args.out);
    save(args.out, '_summary-endpoints', results);
    summarize(args.out);

    if (args.oldApi) {
        await probeOldApi(args, args.out);
    }

    await probeWebsocket(args, args.out);

    console.log(`\nFertig. Alle Rohdaten liegen in ${args.out}`);
}

main().catch(err => {
    console.error(`\nAbbruch: ${errorText(err)}`);
    process.exit(1);
});
