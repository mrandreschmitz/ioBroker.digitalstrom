import React, { useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    Divider,
    FormControlLabel,
    InputAdornment,
    Paper,
    Stack,
    Switch,
    Tab,
    Tabs,
    TextField,
    Typography,
} from '@mui/material';
import CableIcon from '@mui/icons-material/Cable';
import TuneIcon from '@mui/icons-material/Tune';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import KeyIcon from '@mui/icons-material/VpnKey';
import RouterIcon from '@mui/icons-material/Router';
import TimerIcon from '@mui/icons-material/Timer';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';

import { cardSx, DS_GREEN } from './theme.js';

/** One raised card with an icon and a title. */
function Card({ icon, title, children }) {
    return (
        <Paper sx={cardSx}>
            <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mb: 2 }}>
                <Box sx={{ color: DS_GREEN, display: 'flex' }}>{icon}</Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                    {title}
                </Typography>
            </Stack>
            <Divider sx={{ mb: 2.5, borderColor: '#eef2f5' }} />
            {children}
        </Paper>
    );
}

/** A switch with its explanation, laid out like a row of a list. */
function OptionRow({ checked, onChange, label, help }) {
    return (
        <Box sx={{ py: 0.5 }}>
            <FormControlLabel
                control={<Switch checked={!!checked} onChange={e => onChange(e.target.checked)} color="primary" />}
                label={<Typography sx={{ fontWeight: 500 }}>{label}</Typography>}
                sx={{ ml: 0, gap: 1.5 }}
            />
            {help ? (
                <Typography variant="body2" color="text.secondary" sx={{ ml: 7.5, mt: -0.25 }}>
                    {help}
                </Typography>
            ) : null}
        </Box>
    );
}

export default function Settings({ native, onChange, onSendTo, alive, t }) {
    const [tab, setTab] = useState(0);
    // Not every field has an explanation. Both this preview and I18n return the key
    // itself when a text is missing, which must not end up on the screen.
    const th = key => (t(key) === key ? '' : t(key));
    const [credentials, setCredentials] = useState({ username: '', password: '' });
    const [showToken, setShowToken] = useState(false);
    const [tokenState, setTokenState] = useState({ running: false, error: '', done: false });

    const createToken = async () => {
        setTokenState({ running: true, error: '', done: false });
        try {
            const res = await onSendTo('createAppToken', {
                host: native.host || '',
                username: credentials.username,
                password: credentials.password,
            });
            if (res && res.error) {
                setTokenState({ running: false, error: res.error, done: false });
            } else if (res && res.appToken) {
                onChange('appToken', res.appToken);
                setCredentials({ username: '', password: '' });
                setTokenState({ running: false, error: '', done: true });
            } else {
                setTokenState({ running: false, error: 'no answer from the instance', done: false });
            }
        } catch (e) {
            setTokenState({ running: false, error: (e && e.message) || String(e), done: false });
        }
    };

    const canCreate = !!native.host && !!credentials.username && !!credentials.password && !tokenState.running;

    return (
        <Box sx={{ minHeight: '100%', bgcolor: 'background.default' }}>
            {/* Kopfbereich mit Symbol, Name und Kurzbeschreibung */}
            <Box
                sx={{
                    background: 'linear-gradient(180deg, #eef7ef 0%, #f7fbf8 100%)',
                    borderBottom: '1px solid #e2ebe4',
                    px: { xs: 2, sm: 4 },
                    pt: 3,
                }}
            >
                <Stack direction="row" spacing={2} alignItems="center">
                    <Box
                        component="img"
                        src="./digitalstrom.png"
                        alt=""
                        sx={{
                            width: 56,
                            height: 56,
                            borderRadius: '50%',
                            bgcolor: '#fff',
                            p: 0.75,
                            border: '1px solid #e2ebe4',
                            objectFit: 'contain',
                        }}
                    />
                    <Box>
                        <Typography variant="h5">digitalSTROM</Typography>
                        <Typography variant="body2" color="text.secondary">
                            {t('app_subtitle')}
                        </Typography>
                    </Box>
                </Stack>

                <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mt: 1.5 }} textColor="primary" indicatorColor="primary">
                    <Tab icon={<CableIcon fontSize="small" />} iconPosition="start" label={t('tab_connection')} />
                    <Tab icon={<TuneIcon fontSize="small" />} iconPosition="start" label={t('tab_settings')} />
                    <Tab icon={<InfoOutlinedIcon fontSize="small" />} iconPosition="start" label={t('tab_notes')} />
                </Tabs>
            </Box>

            <Box sx={{ px: { xs: 2, sm: 4 }, py: 3, maxWidth: 1080 }}>
                {tab === 0 ? (
                    <>
                        <Card icon={<RouterIcon />} title={t('section_server')}>
                            <Alert severity="info" icon={<InfoOutlinedIcon fontSize="inherit" />} sx={{ mb: 2.5 }}>
                                {t('info_server')}
                            </Alert>
                            <Stack spacing={2.5}>
                                <TextField
                                    label={t('label_host')}
                                    value={native.host || ''}
                                    onChange={e => onChange('host', e.target.value)}
                                    helperText={th('help_host')}
                                    sx={{ maxWidth: 460 }}
                                />
                                <OptionRow
                                    checked={native.validateCertificate}
                                    onChange={v => onChange('validateCertificate', v)}
                                    label={t('label_validateCertificate')}
                                    help={th('help_validateCertificate')}
                                />
                            </Stack>
                        </Card>

                        <Card icon={<KeyIcon />} title={t('section_token')}>
                            <Stack spacing={2.5}>
                                <Box>
                                    <TextField
                                        label={t('label_appToken')}
                                        type={showToken ? 'text' : 'password'}
                                        value={native.appToken || ''}
                                        onChange={e => onChange('appToken', e.target.value)}
                                        helperText={th('help_appToken')}
                                        sx={{ maxWidth: 560 }}
                                        InputProps={{
                                            endAdornment: (
                                                <InputAdornment position="end">
                                                    <Button
                                                        size="small"
                                                        onClick={() => setShowToken(v => !v)}
                                                        sx={{ minWidth: 0, color: 'text.secondary' }}
                                                    >
                                                        {showToken ? (
                                                            <VisibilityOffIcon fontSize="small" />
                                                        ) : (
                                                            <VisibilityIcon fontSize="small" />
                                                        )}
                                                    </Button>
                                                </InputAdornment>
                                            ),
                                        }}
                                    />
                                    <Box sx={{ mt: 1 }}>
                                        <Chip
                                            size="small"
                                            variant="outlined"
                                            color={native.appToken ? 'success' : 'default'}
                                            icon={native.appToken ? <CheckCircleIcon /> : undefined}
                                            label={native.appToken ? t('token_saved') : t('token_missing')}
                                        />
                                    </Box>
                                </Box>

                                <Divider sx={{ borderColor: '#eef2f5' }} />

                                <Alert severity="info" icon={<InfoOutlinedIcon fontSize="inherit" />}>
                                    {t('info_token')}
                                </Alert>

                                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ maxWidth: 640 }}>
                                    <TextField
                                        label={t('label_username')}
                                        value={credentials.username}
                                        autoComplete="off"
                                        onChange={e => setCredentials(c => ({ ...c, username: e.target.value }))}
                                    />
                                    <TextField
                                        label={t('label_password')}
                                        type="password"
                                        value={credentials.password}
                                        autoComplete="new-password"
                                        onChange={e => setCredentials(c => ({ ...c, password: e.target.value }))}
                                    />
                                </Stack>

                                <Box>
                                    <Button
                                        variant="contained"
                                        disabled={!canCreate || alive === false}
                                        onClick={createToken}
                                        startIcon={
                                            tokenState.running ? <CircularProgress size={16} color="inherit" /> : <KeyIcon />
                                        }
                                    >
                                        {t('button_createToken')}
                                    </Button>
                                </Box>

                                {tokenState.error ? <Alert severity="error">{tokenState.error}</Alert> : null}
                                {tokenState.done ? <Alert severity="success">{t('token_saved')}</Alert> : null}
                            </Stack>
                        </Card>
                    </>
                ) : null}

                {tab === 1 ? (
                    <>
                        <Card icon={<TimerIcon />} title={t('section_options')}>
                            <TextField
                                label={t('label_dataPollInterval')}
                                type="number"
                                value={native.dataPollInterval ?? 100}
                                onChange={e => onChange('dataPollInterval', parseInt(e.target.value, 10))}
                                helperText={th('help_dataPollInterval')}
                                sx={{ maxWidth: 320 }}
                                InputProps={{ endAdornment: <InputAdornment position="end">{t('unit_seconds')}</InputAdornment> }}
                            />
                        </Card>

                        <Card icon={<TuneRoundedIcon />} title={t('section_behaviour')}>
                            <Stack spacing={1.5} divider={<Divider sx={{ borderColor: '#eef2f5' }} />}>
                                <OptionRow
                                    checked={native.usePresetValues}
                                    onChange={v => onChange('usePresetValues', v)}
                                    label={t('label_usePresetValues')}
                                    help={th('help_usePresetValues')}
                                />
                                <OptionRow
                                    checked={native.initializeOutputValues}
                                    onChange={v => onChange('initializeOutputValues', v)}
                                    label={t('label_initializeOutputValues')}
                                    help={th('help_initializeOutputValues')}
                                />
                                <OptionRow
                                    checked={native.deleteUnknownObjects}
                                    onChange={v => onChange('deleteUnknownObjects', v)}
                                    label={t('label_deleteUnknownObjects')}
                                    help={th('help_deleteUnknownObjects')}
                                />
                            </Stack>
                        </Card>
                    </>
                ) : null}

                {tab === 2 ? (
                    <Card icon={<InfoOutlinedIcon />} title={t('section_notes')}>
                        <Alert severity="info" icon={<InfoOutlinedIcon fontSize="inherit" />}>
                            {t('info_tls')}
                        </Alert>
                    </Card>
                ) : null}
            </Box>
        </Box>
    );
}
