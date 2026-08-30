// Design preview only. Renders the settings page with fixed data and without any
// connection to a running instance, so the layout can be looked at during development.
// This entry point is not part of the built admin interface.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import { Box, CssBaseline, Fab, Toolbar } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import CloseIcon from '@mui/icons-material/Close';
import Settings from './Settings.jsx';
import { buildTheme } from './theme.js';
import de from './i18n/de.json';
import en from './i18n/en.json';

const dict = { de, en };

/**
 * Imitates the save bar of the admin, which adapter-react-v5 renders with position
 * absolute OVER the dialog. Without it the preview would show more room at the bottom
 * edge than the dialog really has.
 *
 * @param {object} props
 * @param {number} props.offset distance to the bottom edge - 38px in the old admin iframe
 */
function SaveBarStandIn({ offset }) {
    const buttonStyle = { borderRadius: 3, height: 32 };
    return (
        <Toolbar sx={{ position: 'absolute', left: 0, right: 0, bottom: offset, background: '#2a9fd6' }}>
            <Fab variant="extended" aria-label="Save" style={buttonStyle}>
                <SaveIcon sx={{ mr: 1 }} />
                SPEICHERN
            </Fab>
            <Fab variant="extended" aria-label="Save and close" style={{ ...buttonStyle, marginLeft: 10 }}>
                <SaveIcon sx={{ mr: 1 }} />
                SPEICHERN UND SCHLIESSEN
            </Fab>
            <Box sx={{ flexGrow: 1 }} />
            <Fab variant="extended" aria-label="Close" style={buttonStyle}>
                <CloseIcon sx={{ mr: 1 }} />
                SCHLIESSEN
            </Fab>
        </Toolbar>
    );
}

function Preview() {
    const params = new URLSearchParams(location.search);
    const lang = params.get('lang') || 'de';
    const initialTab = parseInt(params.get('tab') || '0', 10);
    // ?iframe=1 shows the variant of the old admin, where the bar sits 38px higher
    const barOffset = params.get('iframe') === '1' ? 38 : 0;
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
            {/* Same geometry as the admin: the dialog fills the window and scrolls inside
                it, the save bar lies on top and stays at the bottom edge. */}
            <Box sx={{ position: 'relative', height: '100vh', overflow: 'hidden' }}>
                <Box sx={{ height: '100%', overflow: 'auto' }}>
                    <Settings
                        native={native}
                        onChange={(attr, value) => setNative(n => ({ ...n, [attr]: value }))}
                        onSendTo={async () => ({ appToken: 'ffffffffffffffffffffffffffffffff' })}
                        alive
                        initialTab={initialTab}
                        t={key => words[key] || key}
                    />
                </Box>
                <SaveBarStandIn offset={barOffset} />
            </Box>
        </ThemeProvider>
    );
}

createRoot(document.getElementById('root')).render(<Preview />);
