import React from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { CssBaseline } from '@mui/material';
import { GenericApp, I18n } from '@iobroker/adapter-react-v5';

import Settings from './Settings.jsx';
import { buildTheme } from './theme.js';
import translations from './i18n/index.js';

export default class App extends GenericApp {
    constructor(props) {
        super(props, {
            translations,
            // Deliberately no encryptedFields here. io-package.json already lists appToken
            // in encryptedNative, and GenericApp.onPrepareLoad decrypts both its own list
            // AND the fields of encryptedNative. Naming the token in both would decrypt it
            // twice, which returns the ciphertext again - saving from that state would
            // store a value the adapter cannot use.
            bottomButtons: true,
            sentryDSN: '',
        });
        this.dialogTheme = buildTheme();
        this.state = { ...this.state, alive: false, status: { connected: false, meteringApi: '', outputApi: '' } };
    }

    async onConnectionReady() {
        const id = `system.adapter.${this.adapterName}.${this.instance}.alive`;
        this.aliveId = id;
        const state = await this.socket.getState(id);
        this.setState({ alive: !!(state && state.val) });
        await this.socket.subscribeState(id, this.onAliveChanged);

        // The status tab shows live which interface serves which task
        this.statusIds = ['info.connection', 'info.meteringApi', 'info.outputApi'].map(
            suffix => `${this.adapterName}.${this.instance}.${suffix}`,
        );
        for (const statusId of this.statusIds) {
            this.applyStatusState(statusId, await this.socket.getState(statusId));
            await this.socket.subscribeState(statusId, this.applyStatusState);
        }
    }

    onAliveChanged = (_id, state) => this.setState({ alive: !!(state && state.val) });

    applyStatusState = (id, state) => {
        const value = state ? state.val : null;
        if (id.endsWith('.info.connection')) {
            this.setState(old => ({ status: { ...old.status, connected: !!value } }));
        } else if (id.endsWith('.info.meteringApi')) {
            this.setState(old => ({ status: { ...old.status, meteringApi: value || '' } }));
        } else if (id.endsWith('.info.outputApi')) {
            this.setState(old => ({ status: { ...old.status, outputApi: value || '' } }));
        }
    };

    componentWillUnmount() {
        if (this.aliveId) {
            this.socket.unsubscribeState(this.aliveId, this.onAliveChanged);
        }
        (this.statusIds || []).forEach(statusId => this.socket.unsubscribeState(statusId, this.applyStatusState));
        super.componentWillUnmount();
    }

    /**
     * Send a message to the running instance and resolve with its answer.
     *
     * @param command the command of the message handler in main.js
     * @param data payload of the message
     */
    sendToInstance = (command, data) =>
        this.socket.sendTo(`${this.adapterName}.${this.instance}`, command, data);

    render() {
        if (!this.state.loaded) {
            return super.render();
        }

        return (
            <ThemeProvider theme={this.dialogTheme}>
                <CssBaseline />
                <Settings
                    native={this.state.native}
                    alive={this.state.alive}
                    status={this.state.status}
                    t={key => I18n.t(key)}
                    onChange={(attr, value) => this.updateNativeValue(attr, value)}
                    onSendTo={this.sendToInstance}
                />
                {this.renderError()}
                {this.renderSaveCloseButtons()}
            </ThemeProvider>
        );
    }
}
