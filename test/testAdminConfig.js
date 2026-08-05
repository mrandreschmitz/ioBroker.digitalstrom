const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

// The admin adapter validates admin/jsonConfig.json against its own schema and only
// reports a warning in its log - a broken config would stay unnoticed otherwise.
// These checks mirror the root level rules of that schema (if/then/else branch) without
// needing network access for the schema itself.
const ROOT_KEYS_ALLOWED = ['type', '$schema', 'i18n', 'debug', 'items', 'iconPosition', 'tabsStyle'];

describe('admin/jsonConfig.json', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'admin', 'jsonConfig.json'), 'utf8');
    let config;

    it('is valid JSON', () => {
        config = JSON.parse(raw);
        expect(config).to.be.an('object');
    });

    it('declares a supported root type', () => {
        expect(['panel', 'tabs']).to.include(config.type);
    });

    it('declares i18n - the schema requires it', () => {
        // All texts are inline multilingual objects, so no translation files are used
        expect(config).to.have.property('i18n');
        expect(config.i18n).to.equal(false);
    });

    it('uses no root properties the schema forbids', () => {
        const unexpected = Object.keys(config).filter(key => !ROOT_KEYS_ALLOWED.includes(key));
        expect(unexpected, `unknown root properties: ${unexpected.join(', ')}`).to.deep.equal([]);
    });

    it('gives every item a type', () => {
        const missing = Object.keys(config.items).filter(name => !config.items[name].type);
        expect(missing, `items without type: ${missing.join(', ')}`).to.deep.equal([]);
    });

    it('translates every label into at least German and English', () => {
        const incomplete = [];
        Object.keys(config.items).forEach(name => {
            const item = config.items[name];
            ['label', 'text', 'help'].forEach(field => {
                const value = item[field];
                if (value && typeof value === 'object' && (!value.de || !value.en)) {
                    incomplete.push(`${name}.${field}`);
                }
            });
        });
        expect(incomplete, `incomplete translations: ${incomplete.join(', ')}`).to.deep.equal([]);
    });
});
