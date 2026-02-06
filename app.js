// app.js — XPwner WebSocket Server v2.0 (modularizado)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const WebSocket = require('ws');

// Handlers
const { handleAuth } = require('./src/handlers/auth');
const { handleRequestAction, handleTaskAccepted, handleTaskRejected, handleNewAction, handleStopAction } = require('./src/handlers/actions');
const { handleStatus, handleProgress, handleTokenFail, handleTokenSuccess, handleTweetSnapshot } = require('./src/handlers/status');
const { handleRequestWarmerJob, handleWarmerNext, handleWarmerResult } = require('./src/handlers/warmer');
const { handleRequestScrapingJob, handleScrapingNext, handleScrapingNextBatch, handleScrapingResult, handleScrapingResultBatch, handleScrapingJobComplete, handleScraperAccountFail, handleScraperAccountSuccess } = require('./src/handlers/scraping');
// boot check removed
const { handleRequestToken, handleTokenReport, handleRequestTokenBatch, handleTokenReportBatch, cleanupStaleLocks, cleanupOldLogs } = require('./src/handlers/tokenManager');
const { handleUpdate, handleLog } = require('./src/handlers/monitor');
const { handleDisconnect } = require('./src/handlers/disconnect');

// Servidor WebSocket
const wsPort = process.env.WS_PORT || '3005';
const wss = new WebSocket.Server({ port: wsPort });

// ── Ping/Pong heartbeat — detectar workers muertos cada 30s ──
const HEARTBEAT_INTERVAL = 30000;
setInterval(() => {
    wss.clients.forEach((socket) => {
        if (socket._isAliveWs === false) {
            // No respondió al ping anterior → muerto
            console.log(`[Heartbeat] Worker ${socket.workerId || 'unknown'} no respondió ping, cerrando`);
            return socket.terminate();
        }
        socket._isAliveWs = false;
        socket.ping();
    });
}, HEARTBEAT_INTERVAL);

wss.on('connection', (socket) => {
    // client connected

    socket.isAlive = false;
    socket._isAliveWs = true; // Para heartbeat ping/pong
    socket.userId = null;
    socket.clientType = "monitor";
    socket.workerId = null;

    socket.on('pong', () => { socket._isAliveWs = true; });

    socket.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            // (logs removed)

            // === AUTENTICACIÓN ===
            if (data.type === 'auth' && data.token) {
                await handleAuth(socket, data);
            }

            // === ACCIONES (desde monitors) ===
            else if (data.type === 'request_action' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                try {
                    await handleRequestAction(socket, data);
                } catch (err) {
                    console.error('[Server] Error asignando acción:', err.message);
                    socket.send(JSON.stringify({ type: 'no_action' }));
                }
            }

            else if (data.type === 'task_accepted' && socket.isAlive && socket.userId) {
                await handleTaskAccepted(socket, data);
            }

            else if (data.type === 'task_rejected' && socket.isAlive && socket.userId) {
                await handleTaskRejected(socket, data);
            }

            // === NUEVA ACCIÓN (desde panels — push instantáneo) ===
            else if (data.type === 'new_action' && socket.isAlive && socket.userId && socket.clientType === 'panel') {
                handleNewAction(socket, data);
            }

            // === DETENER ACCIÓN (desde panels — stop action) ===
            else if (data.type === 'stop_action' && socket.isAlive && socket.userId && socket.clientType === 'panel') {
                try {
                    await handleStopAction(socket, data);
                } catch (err) {
                    console.error('[Server] Error en stop_action:', err.message);
                    socket.send(JSON.stringify({ type: 'stop_action_result', action_id: data.action_id, success: false, message: 'Error interno' }));
                }
            }

            // === STATUS Y PROGRESO (desde monitors) ===
            else if (data.type === 'status' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                await handleStatus(socket, data);
            }

            else if (data.type === 'progreso' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                console.log(`[Progreso] Recibido de worker ${socket.workerId}:`, data);
                await handleProgress(socket, data);
            }

            // === TOKEN HEALTH (desde monitors — legacy) ===
            // === TWEET SNAPSHOT (desde monitors) ===
            else if (data.type === 'tweet_snapshot' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                await handleTweetSnapshot(socket, data);
            }

            else if (data.type === 'token_fail' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                await handleTokenFail(socket, data);
            }

            else if (data.type === 'token_success' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                await handleTokenSuccess(socket, data);
            }

            // === TOKEN MANAGER v2 (desde monitors) ===
            else if (data.type === 'request_token' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                try {
                    await handleRequestToken(socket, data);
                } catch (err) {
                    console.error('[Server] Error en request_token:', err.message);
                    socket.send(JSON.stringify({ type: 'no_token_available', reason: 'server_error' }));
                }
            }

            else if (data.type === 'token_report' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                await handleTokenReport(socket, data);
            }

            // === TOKEN MANAGER v2 — BATCH (desde monitors) ===
            else if (data.type === 'request_token_batch' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                try {
                    await handleRequestTokenBatch(socket, data);
                } catch (err) {
                    console.error('[Server] Error en request_token_batch:', err.message);
                    socket.send(JSON.stringify({ type: 'token_batch_assigned', request_id: data.request_id || null, tokens: [], reason: 'server_error' }));
                }
            }

            else if (data.type === 'token_report_batch' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                await handleTokenReportBatch(socket, data);
            }

            // === XWARMER JOBS (desde monitors) ===
            else if (data.type === 'request_warmer_job' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                try {
                    await handleRequestWarmerJob(socket);
                } catch (err) {
                    console.error('[Server] Error en request_warmer_job:', err.message);
                    socket.send(JSON.stringify({ type: 'no_warmer_job', reason: 'server_error' }));
                }
            }

            else if (data.type === 'warmer_next' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                try {
                    await handleWarmerNext(socket, data);
                } catch (err) {
                    console.error('[Server] Error en warmer_next:', err.message);
                    socket.send(JSON.stringify({ type: 'warmer_done', job_id: data.job_id, error: err.message }));
                }
            }

            else if (data.type === 'warmer_result' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                try {
                    await handleWarmerResult(socket, data);
                } catch (err) {
                    console.error('[Server] Error en warmer_result:', err.message);
                    socket.send(JSON.stringify({ type: 'warmer_result_ack', job_id: data.job_id, ok: false }));
                }
            }

            // === SCRAPING JOBS (desde monitors) ===
            else if (data.type === 'request_scraping_job' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                try {
                    await handleRequestScrapingJob(socket);
                } catch (err) {
                    console.error('[Server] Error en request_scraping_job:', err.message);
                    socket.send(JSON.stringify({ type: 'no_scraping_job', reason: 'server_error' }));
                }
            }

            else if (data.type === 'scraping_next' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                try {
                    await handleScrapingNext(socket, data);
                } catch (err) {
                    console.error('[Server] Error en scraping_next:', err.message);
                    socket.send(JSON.stringify({ type: 'scraping_done', job_id: data.job_id, error: err.message }));
                }
            }

            else if (data.type === 'scraping_next_batch' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                try {
                    await handleScrapingNextBatch(socket, data);
                } catch (err) {
                    console.error('[Server] Error en scraping_next_batch:', err.message);
                    socket.send(JSON.stringify({ type: 'scraping_done', job_id: data.job_id, error: err.message }));
                }
            }

            else if (data.type === 'scraping_result' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                try {
                    await handleScrapingResult(socket, data);
                } catch (err) {
                    console.error('[Server] Error en scraping_result:', err.message);
                    socket.send(JSON.stringify({ type: 'scraping_result_ack', job_id: data.job_id, ok: false }));
                }
            }

            else if (data.type === 'scraping_result_batch' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                try {
                    await handleScrapingResultBatch(socket, data);
                } catch (err) {
                    console.error('[Server] Error en scraping_result_batch:', err.message);
                    socket.send(JSON.stringify({ type: 'scraping_result_batch_ack', job_id: data.job_id, ok: false }));
                }
            }

            else if (data.type === 'scraping_job_complete' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                await handleScrapingJobComplete(socket, data);
            }

            else if (data.type === 'scraper_account_fail' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                await handleScraperAccountFail(socket, data);
            }

            else if (data.type === 'scraper_account_success' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                await handleScraperAccountSuccess(socket, data);
            }

            // === MÉTRICAS Y LOGS (desde monitors) ===
            else if (data.type === 'update' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                await handleUpdate(socket, data);
            }

            else if (data.type === 'log' && socket.isAlive && socket.userId && socket.clientType === 'monitor') {
                await handleLog(socket, data);
            }

        } catch (err) {
            console.error('[Server] Error procesando mensaje:', err.message);
        }
    });

    socket.on('close', async () => {
        try {
            await handleDisconnect(socket);
        } catch (err) {
            console.error('[Server] Error en disconnect:', err.message);
        }
    });

    socket.on('error', (error) => {
        console.error('[Server] Error en conexión:', error.message);
    });
});

console.log(`[Server] XPwner WebSocket v2.1 escuchando en puerto ${wsPort}`);

// === CLEANUP INTERVALS ===
// Desbloquear tokens que llevan >10 min bloqueados (cada 2 min)
setInterval(cleanupStaleLocks, 2 * 60 * 1000);

// Limpiar logs de token_actions_log > 7 días (cada hora)
setInterval(cleanupOldLogs, 60 * 60 * 1000);
