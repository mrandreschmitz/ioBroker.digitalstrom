const { expect } = require('chai');
const path = require('path');
const fs = require('fs');

// Reproduction of how the admin evaluates "jsonData" (@iobroker/json-config,
// ConfigGeneric.escapeString + ConfigSendto). The pattern is not a simple placeholder
// replacement but a real JavaScript template literal, so credentials with special
// characters must be inserted in a JSON safe way.

/**
 * Copy of ConfigGeneric.escapeString from `@iobroker/json-config`.
 * Current admin versions escape quotes and backslashes in ${data.x} tokens, but no
 * control characters - which is exactly why the values are inserted via JSON.stringify.
 *
 * @param {string} str the jsonData pattern
 * @param {object} data current form values
 * @returns {string} pattern prepared for the template literal
 */
function escapeString(str, data) {
    if (typeof str !== 'string') {
        return '';
    }
    str = str.replace(/`/g, '\\`');
    str = str.replace(/\$\{([^}]+)\}/g, (match, p1) => {
        if (p1 && typeof p1 === 'string' && p1.startsWith('data.')) {
            const value = data[p1.replace(/^data\./, '')];
            if (typeof value === 'string') {
                if (value.includes('\\') || value.includes('"')) {
                    return `\${${p1}.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"')}`;
                }
            }
        }
        return match;
    });
    return str;
}

/**
 * Evaluates a jsonData pattern exactly like the admin does.
 *
 * @param {string} pattern jsonData from jsonConfig.json
 * @param {object} data current form values
 * @returns {string} the string the admin would hand to JSON.parse
 */
function evaluatePattern(pattern, data) {
    const f = new Function('data', `return \`${escapeString(pattern, data)}\``);
    return f(data);
}

const jsonConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'admin', 'jsonConfig.json'), 'utf8'));

describe('admin createAppToken sendTo', () => {
    const pattern = jsonConfig.items._createAppToken.jsonData;

    it('is wired to the createAppToken command and fills the native app token', () => {
        expect(jsonConfig.items._createAppToken.command).to.equal('createAppToken');
        expect(jsonConfig.items._createAppToken.useNative).to.equal(true);
    });

    it('keeps the password field a password field', () => {
        expect(jsonConfig.items.password.type).to.equal('password');
    });

    it('inserts the values JSON safe instead of concatenating strings', () => {
        // A raw "${data.password}" inside quotes is what breaks on special characters
        expect(pattern, 'values must not be pasted into a quoted JSON string').to.not.contain('"${data.password}"');
        expect(pattern).to.contain('JSON.stringify(data.password');
    });

    const nastyValues = [
        ['simple', 'geheim123'],
        ['double quote', 'p@ss"word'],
        ['backslash', 'pass\\word'],
        ['backslash and quote', 'a\\"b'],
        ['newline', 'pass\nword'],
        ['carriage return', 'pass\r\nword'],
        ['tab', 'pass\tword'],
        ['unicode', 'paßwörd-日本語-🔐'],
        ['json fragment', '{"a": 1}'],
        ['template literal', '${data.host}'],
        ['backtick', 'pa`ss'],
        ['only special chars', '"\\\n\t'],
    ];

    nastyValues.forEach(([label, password]) => {
        it(`survives a password with ${label}`, () => {
            const data = { host: '192.168.1.10', username: 'user', password };
            const raw = evaluatePattern(pattern, data);
            /** @type {any} */
            let parsed = null;
            expect(() => {
                parsed = JSON.parse(raw);
            }, `must stay valid JSON: ${raw}`).to.not.throw();
            expect(parsed, 'the payload must be parseable').to.be.an('object');
            expect(parsed.password, 'the password must arrive unchanged').to.equal(password);
            expect(parsed.host).to.equal('192.168.1.10');
            expect(parsed.username).to.equal('user');
        });
    });

    nastyValues.forEach(([label, value]) => {
        it(`survives a username with ${label}`, () => {
            const data = { host: '192.168.1.10', username: value, password: 'x' };
            const parsed = JSON.parse(evaluatePattern(pattern, data));
            expect(parsed.username).to.equal(value);
        });
    });

    it('survives a host with special characters', () => {
        const data = { host: '[2001:db8::1]:8080', username: 'u', password: 'p' };
        const parsed = JSON.parse(evaluatePattern(pattern, data));
        expect(parsed.host).to.equal('[2001:db8::1]:8080');
    });

    it('produces valid JSON even when a field is still empty', () => {
        const parsed = JSON.parse(evaluatePattern(pattern, {}));
        expect(parsed).to.deep.equal({ host: '', username: '', password: '' });
    });

    it('documents that the old pattern really was broken', () => {
        // Guards against someone reintroducing the plain concatenation
        const oldPattern = '{"host": "${data.host}", "username": "${data.username}", "password": "${data.password}"}';
        const data = { host: '1.2.3.4', username: 'user', password: 'pass\nword' };
        expect(() => JSON.parse(evaluatePattern(oldPattern, data))).to.throw();
        // and the new one handles the same input
        expect(() => JSON.parse(evaluatePattern(pattern, data))).to.not.throw();
    });
});
