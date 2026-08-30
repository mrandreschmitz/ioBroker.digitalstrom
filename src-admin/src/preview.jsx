// Design preview only. Renders the settings page with fixed data and without any
// connection to a running instance, so the layout can be looked at during development.
// This entry point is not part of the built admin interface.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import { CssBaseline } from '@mui/material';
import Settings from './Settings.jsx';
import { buildTheme } from './theme.js';
import de from './i18n/de.json';
import en from './i18n/en.json';

const dict = { de, en };

function Preview() {
    const params = new URLSearchParams(location.search);
    const lang = params.get('lang') || 'de';
    const initialTab = parseInt(params.get('tab') || '0', 10);
    const words = dict[lang] || dict.en;
    const [native, setNative] = useState({
        host: '10.13.10.4',
        validateCertificate: false,
        appToken: '0123456789abcdef0123456789abcdef',
        dataPollInterval: 100,
        usePresetValues: true,
        initializeOutputValues: true,
        deleteUnknownObjects: false,
    });

    return (
        <ThemeProvider theme={buildTheme()}>
            <CssBaseline />
            <Settings
                native={native}
                onChange={(attr, value) => setNative(n => ({ ...n, [attr]: value }))}
                onSendTo={async () => ({ appToken: 'ffffffffffffffffffffffffffffffff' })}
                alive
                initialTab={initialTab}
                t={key => words[key] || key}
            />
        </ThemeProvider>
    );
}

createRoot(document.getElementById('root')).render(<Preview />);
