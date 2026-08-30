const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { collectJsonConfigItems } = require('./lib/helpers');

// The admin adapter validates admin/jsonConfig.json against its own schema and only
// reports a warning in its log - a broken config would stay unnoticed otherwise.
// These checks mirror the rules of that schema without needing network access for it.
const ROOT_KEYS_ALLOWED = ['type', '$schema', 'i18n', 'debug', 'items', 'iconPosition', 'tabsStyle'];

// componentType enum of the official schema
// (ioBroker.admin/packages/jsonConfig/schemas/jsonConfig.json)
const COMPONENT_TYPES = [
    'accordion',
    'alive',
    'autocomplete',
    'autocompleteSendTo',
    'certificate',
    'certificates',
    'checkDocker',
    'checkLicense',
    'checkbox',
    'chips',
    'color',
    'coordinates',
    'credential',
    'cron',
    'custom',
    'datePicker',
    'deviceManager',
    'divider',
    'file',
    'fileSelector',
    'func',
    'header',
    'icon',
    'iframe',
    'iframeSendTo',
    'image',
    'imageSendTo',
    'infoBox',
    'instance',
    'interface',
    'ip',
    'jsonEditor',
    'language',
    'number',
    'oauth2',
    'objectId',
    'panel',
    'password',
    'pattern',
    'port',
    'qrCode',
    'qrCodeSendTo',
    'room',
    'select',
    'selectSendTo',
    'sendTo',
    'setState',
    'slider',
    'state',
    'staticImage',
    'staticInfo',
    'staticLink',
    'staticText',
    'table',
    'text',
    'textSendTo',
    'timePicker',
    'user',
    'uuid',
    'yamlEditor',
];

// Enum constrained properties of the schema, per component type. admin validates the whole
// config against its schema and only writes a warning into its log - an invalid value would
// otherwise stay unnoticed until a user reports "digitalstrom has an invalid jsonConfig".
const ENUM_PROPERTIES = {
    divider: { color: ['primary', 'secondary'] },
    infoBox: { boxType: ['info', 'warning', 'error', 'ok'], iconPosition: ['top', 'middle'] },
    staticText: { format: ['text', 'html', 'json'], variant: ['contained', 'outlined', 'text'] },
};

// Every option of "native" in io-package.json needs a control, otherwise it cannot be
// configured at all. username/password only exist to create a token and are never stored.
const UI_ONLY_FIELDS = ['username', 'password'];

describe('admin/jsonConfig.json', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'admin', 'jsonConfig.json'), 'utf8');
    const ioPackage = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'io-package.json'), 'utf8'));
    let config;
    let items;

    it('is valid JSON', () => {
        config = JSON.parse(raw);
        items = collectJsonConfigItems(config);
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

    it('contains only tabs of the type panel', () => {
        const wrong = Object.keys(config.items).filter(name => config.items[name].type !== 'panel');
        expect(wrong, `tabs must be panels: ${wrong.join(', ')}`).to.deep.equal([]);
    });

    it('gives every item a type the schema knows', () => {
        const bad = Object.keys(items).filter(name => !COMPONENT_TYPES.includes(items[name].type));
        expect(bad, `unknown component types: ${bad.map(n => `${n}=${items[n].type}`).join(', ')}`).to.deep.equal([]);
    });

    // Regression: the dividers carried a hex colour, but the schema only allows
    // "primary"/"secondary" there. admin refused the whole config with a warning.
    it('uses only allowed values for the enum properties of the schema', () => {
        const bad = [];
        Object.keys(items).forEach(name => {
            const item = items[name];
            const constraints = ENUM_PROPERTIES[item.type];
            if (!constraints) {
                return;
            }
            Object.keys(constraints).forEach(prop => {
                if (item[prop] !== undefined && !constraints[prop].includes(item[prop])) {
                    bad.push(`${name}.${prop} = ${JSON.stringify(item[prop])}, allowed: ${constraints[prop]}`);
                }
            });
        });
        expect(bad, `invalid enum values: ${bad.join('; ')}`).to.deep.equal([]);
    });

    it('styles colours through style/darkStyle, not through constrained properties', () => {
        // A colour of the digitalSTROM palette belongs into style, the schema properties
        // only know the two theme colours
        const dividers = Object.keys(items).filter(name => items[name].type === 'divider');
        expect(dividers.length, 'the layout uses dividers').to.be.above(0);
        dividers.forEach(name => {
            const item = items[name];
            expect(item.color, `${name} must not carry a colour value`).to.equal(undefined);
            expect(item.style && item.style.backgroundColor, `${name} keeps its colour in style`).to.be.a('string');
        });
    });

    it('translates every label into at least German and English', () => {
        const incomplete = [];
        Object.keys(items).forEach(name => {
            ['label', 'text', 'help', 'title'].forEach(field => {
                const value = items[name][field];
                if (value && typeof value === 'object' && (!value.de || !value.en)) {
                    incomplete.push(`${name}.${field}`);
                }
            });
        });
        expect(incomplete, `incomplete translations: ${incomplete.join(', ')}`).to.deep.equal([]);
    });

    it('translates every text into all languages the other texts use', () => {
        const languages = new Set();
        Object.keys(items).forEach(name =>
            ['label', 'text', 'help', 'title'].forEach(field => {
                const value = items[name][field];
                if (value && typeof value === 'object') {
                    Object.keys(value).forEach(lang => languages.add(lang));
                }
            }),
        );
        const missing = [];
        Object.keys(items).forEach(name =>
            ['label', 'text', 'help', 'title'].forEach(field => {
                const value = items[name][field];
                if (value && typeof value === 'object') {
                    [...languages].forEach(lang => !value[lang] && missing.push(`${name}.${field}.${lang}`));
                }
            }),
        );
        expect(missing, `missing translations: ${missing.join(', ')}`).to.deep.equal([]);
    });

    // Regression guard for the redesign: a renamed or forgotten control would silently
    // make an option unconfigurable while the value stays in the instance object
    it('offers a control for every option of io-package native', () => {
        const missing = Object.keys(ioPackage.native).filter(key => !items[key]);
        expect(missing, `options without a control: ${missing.join(', ')}`).to.deep.equal([]);
    });

    it('stores nothing that is not part of native', () => {
        const nativeKeys = Object.keys(ioPackage.native);
        const stored = Object.keys(items).filter(
            name => !name.startsWith('_') && items[name].type !== 'panel' && !items[name].doNotSave,
        );
        const unexpected = stored.filter(name => !nativeKeys.includes(name));
        expect(unexpected, `controls without a native key: ${unexpected.join(', ')}`).to.deep.equal([]);
        UI_ONLY_FIELDS.forEach(name => expect(items[name].doNotSave, `${name} must never be stored`).to.equal(true));
    });

    it('keeps the app token masked', () => {
        expect(items.appToken.type, 'the token must not be a plain text field').to.equal('password');
        expect(ioPackage.encryptedNative, 'and it must be encrypted').to.include('appToken');
        expect(ioPackage.protectedNative).to.include('appToken');
    });
});
