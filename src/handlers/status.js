// src/handlers/status.js — Manejo de status, progreso y token health
const db = require('../db');
const { sendCompletionNotification } = require('./telegram');

/**
 * Worker reporta status de una acción (Completado / Error)
 */
async function handleStatus(socket, data) {
    const { action_id, status, message: errorMsg, tipo } = data;

    if (action_id && status && errorMsg) {
        const isWarmer = tipo.startsWith('xwarmer_');
        const tableName = isWarmer ? 'xwarmer_actions' : 'actions';
        const errName = isWarmer ? 'error_msg' : 'comentario';

        const [actionRows] = await db.query(
            `SELECT worker_id, ${errName} as prev_comment${isWarmer ? ', account_id' : ''} FROM ${tableName} WHERE id = ?`, 
            [action_id]
        );
        if (actionRows.length > 0 && actionRows[0].worker_id === socket.workerId) {
            // Si la acción vuelve a "En Cola" (timeout/crash), no sobreescribir URLs acumuladas
            let commentToSave = errorMsg;
            if (status === 'En Cola' && actionRows[0].prev_comment && actionRows[0].prev_comment.includes('https://')) {
                commentToSave = actionRows[0].prev_comment;
            }
            // For intermediate statuses (En Proceso), don't overwrite terminal states (race condition fix)
            if (status === 'Completado' || status === 'Error') {
                await db.query(`UPDATE ${tableName} SET estado = ?, ${errName} = ? WHERE id = ?`, [status, commentToSave, action_id]);
            } else if (status === 'En Cola') {
                // Devolver a cola: limpiar worker_id para que otro worker pueda tomarla
                await db.query(`UPDATE ${tableName} SET estado = 'En Cola', worker_id = NULL, ${errName} = ? WHERE id = ?`, [commentToSave, action_id]);
                console.log(`[Status] Acción ${action_id} devuelta a 'En Cola' por worker ${socket.workerId}`);
            } else {
                await db.query(`UPDATE ${tableName} SET estado = CASE WHEN estado NOT IN ('Completado', 'Error') THEN ? ELSE estado END, ${errName} = ? WHERE id = ?`, [status, commentToSave, action_id]);
            }
            
            // Clean up media data when action is completed or errored (free DB space)
            if (!isWarmer && (status === 'Completado' || status === 'Error')) {
                await db.query(`UPDATE actions SET media = NULL WHERE id = ? AND media IS NOT NULL`, [action_id]);
            }
            
            console.log(`[Status] Acción ${action_id} actualizada: ${status}`);

            // xWarmer: actualizar xchecker_accounts con resultado
            if (isWarmer && actionRows[0].account_id) {
                try {
                    await updateWarmerAccountHealth(actionRows[0].account_id, status, errorMsg);
                } catch (err) {
                    console.error(`[Status] Error actualizando cuenta warmer ${actionRows[0].account_id}:`, err.message);
                }
            }

            // Notificación Telegram solo al completar acciones normales
            if (status === 'Completado' && !isWarmer) {
                sendCompletionNotification(action_id);
            }
        } else {
            console.warn(`[Status] Worker ${socket.workerId} intentó actualizar acción ${action_id} no asignada. Ignorando.`);
        }
    }

    if (status && status.toLowerCase() === 'error') {
        await db.query('UPDATE cuentas SET estado_monitor = ? WHERE id = ?', ['Error', socket.userId]);
    }
}

/**
 * Actualiza xchecker_accounts basado en resultado de acción xWarmer
 */
async function updateWarmerAccountHealth(accountId, status, errorMsg) {
    if (status === 'Completado') {
        await db.query(
            `UPDATE xchecker_accounts SET 
                ultimo_warmeo = NOW(),
                ultimo_uso = NOW(),
                fails_consecutivos = 0,
                estado_salud = 'activo'
            WHERE id = ?`,
            [accountId]
        );
        console.log(`[WarmerHealth] Cuenta ${accountId} warmed OK`);
    } else if (status === 'Error') {
        // Analizar el error para determinar estado de salud
        let estadoSalud = 'activo';
        const errStr = (errorMsg || '').toLowerCase();

        if (errStr.includes('could not authenticate') || errStr.includes('deslogueado') || errStr.includes('401')) {
            estadoSalud = 'deslogueado';
        } else if (errStr.includes('suspended') || errStr.includes('suspendido')) {
            estadoSalud = 'suspendido';
        } else if (errStr.includes('rate limit') || errStr.includes('429')) {
            estadoSalud = 'rate_limited';
        }

        await db.query(
            `UPDATE xchecker_accounts SET 
                ultimo_uso = NOW(),
                fails_consecutivos = fails_consecutivos + 1,
                ultimo_error = ?,
                estado_salud = CASE 
                    WHEN ? != 'activo' THEN ?
                    WHEN fails_consecutivos + 1 >= 10 THEN 'muerto'
                    ELSE estado_salud
                END
            WHERE id = ?`,
            [errorMsg || 'xwarmer error', estadoSalud, estadoSalud, accountId]
        );
        console.log(`[WarmerHealth] Cuenta ${accountId} error: ${estadoSalud}`);
    }
}

/**
 * Worker reporta progreso de una acción
 */
async function handleProgress(socket, data) {
    const { action_id, tipo, cantidad } = data;
    const tableName = 'actions';

    const [actionRows] = await db.query('SELECT worker_id FROM ' + tableName + ' WHERE id = ?', [action_id]);
    if (actionRows.length > 0 && actionRows[0].worker_id === socket.workerId) {
        // Only set estado to 'En Proceso' if not already Completado/Error (race condition fix)
        await db.query(
            'UPDATE ' + tableName + ' SET estado = CASE WHEN estado NOT IN (\'Completado\', \'Error\') THEN \'En Proceso\' ELSE estado END, acciones_realizadas = acciones_realizadas + ? WHERE id = ?',
            [cantidad, action_id]
        );
        console.log(`[Status] Progreso: Acción ${action_id} +${cantidad} por worker ${socket.workerId}`);
    } else {
        console.warn(`[Status] Worker ${socket.workerId} intentó actualizar progreso de acción ${action_id} no asignada. Ignorando.`);
    }
}

/**
 * Worker reporta fallo de un token específico
 */
async function handleTokenFail(socket, data) {
    const { auth_token, error_msg } = data;
    if (!auth_token || !socket.userId) return;

    try {
        // Upsert: incrementa fallos o inserta nuevo registro
        await db.query(`
            INSERT INTO token_health (cuentas_id, auth_token, fails_consecutivos, ultimo_error, ultimo_uso, estado)
            VALUES (?, ?, 1, ?, NOW(), 'activo')
            ON DUPLICATE KEY UPDATE
                fails_consecutivos = fails_consecutivos + 1,
                ultimo_error = VALUES(ultimo_error),
                ultimo_uso = NOW(),
                estado = CASE 
                    WHEN fails_consecutivos + 1 >= 10 THEN 'muerto'
                    WHEN fails_consecutivos + 1 >= 5 THEN 'enfermo'
                    ELSE 'activo'
                END
        `, [socket.userId, auth_token, error_msg || 'unknown']);

        console.log(`[TokenHealth] Token fail reportado por worker ${socket.workerId}: ${auth_token.substring(0, 20)}...`);
    } catch (err) {
        console.error(`[TokenHealth] Error guardando token fail:`, err.message);
    }
}

/**
 * Worker reporta éxito de un token (resetea contador de fallos)
 */
async function handleTokenSuccess(socket, data) {
    const { auth_token } = data;
    if (!auth_token || !socket.userId) return;

    try {
        await db.query(`
            UPDATE token_health 
            SET fails_consecutivos = 0, estado = 'activo', ultimo_uso = NOW()
            WHERE cuentas_id = ? AND auth_token = ?
        `, [socket.userId, auth_token]);
    } catch (err) {
        // Silencioso — no es crítico
    }
}

/**
 * Worker envía snapshot del tweet al completar una acción
 * Guarda el JSON en acciones.tweet_snapshot
 */
async function handleTweetSnapshot(socket, data) {
    const { action_id, data: tweetData } = data;
    if (!action_id || !tweetData) return;

    try {
        const [actionRows] = await db.query('SELECT worker_id FROM actions WHERE id = ?', [action_id]);
        if (actionRows.length > 0 && actionRows[0].worker_id === socket.workerId) {
            await db.query('UPDATE actions SET tweet_snapshot = ? WHERE id = ?', [JSON.stringify(tweetData), action_id]);
            console.log(`[Snapshot] Tweet snapshot guardado para acción ${action_id} - @${tweetData.user?.screen_name || 'unknown'}`);
        }
    } catch (err) {
        console.error(`[Snapshot] Error guardando snapshot para acción ${action_id}:`, err.message);
    }
}

module.exports = {
    handleStatus,
    handleProgress,
    handleTokenFail,
    handleTokenSuccess,
    handleTweetSnapshot
};
