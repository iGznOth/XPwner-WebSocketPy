// src/handlers/warmer.js — xWarmer job-based handler
// Flujo: Worker pide job → pide cuenta+destino uno a uno → reporta resultado
const db = require('../db');

/**
 * Worker solicita un warmer job disponible
 */
async function handleRequestWarmerJob(socket) {
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [jobs] = await connection.query(
            `SELECT id, tipo, total_cuentas, cuentas_ejecutadas, apm, request, threads, grupo_nicks
             FROM xwarmer_actions
             WHERE estado = 'En Cola'
             ORDER BY created_at ASC
             LIMIT 1
             FOR UPDATE`,
            []
        );

        if (jobs.length === 0) {
            await connection.commit();
            socket.send(JSON.stringify({ type: 'no_warmer_job' }));
            return;
        }

        const job = jobs[0];

        await connection.query(
            `UPDATE xwarmer_actions SET estado = 'En Proceso', worker_id = ?, started_at = NOW() WHERE id = ?`,
            [socket.workerId, job.id]
        );

        await connection.commit();

        console.log(`[Warmer] Job ${job.id} (${job.tipo}) asignado a worker ${socket.workerId}`);

        socket.send(JSON.stringify({
            type: 'warmer_job',
            job: {
                id: job.id,
                tipo: job.tipo,
                total_cuentas: job.total_cuentas,
                cuentas_ejecutadas: job.cuentas_ejecutadas,
                apm: job.apm,
                request: job.request,
                threads: job.threads,
                grupo_nicks: job.grupo_nicks
            }
        }));
    } catch (err) {
        await connection.rollback();
        console.error('[Warmer] Error asignando job:', err.message);
        socket.send(JSON.stringify({ type: 'no_warmer_job', reason: 'db_error' }));
    } finally {
        connection.release();
    }
}

/**
 * Worker pide siguiente cuenta + destino para un job
 */
async function handleWarmerNext(socket, data) {
    const { job_id } = data;
    if (!job_id) {
        socket.send(JSON.stringify({ type: 'warmer_done', job_id: 0, error: 'missing job_id' }));
        return;
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        // Cargar job
        const [jobRows] = await connection.query(
            `SELECT * FROM xwarmer_actions WHERE id = ? FOR UPDATE`,
            [job_id]
        );

        if (jobRows.length === 0) {
            await connection.commit();
            socket.send(JSON.stringify({ type: 'warmer_done', job_id, error: 'job not found' }));
            return;
        }

        const job = jobRows[0];

        // Buscar siguiente cuenta del deck (no procesada en este job)
        const [accounts] = await connection.query(
            `SELECT xa.id, xa.nick, xa.auth_token, xa.ct0, xa.cookies_full
             FROM xchecker_accounts xa
             WHERE xa.deck_id = ?
               AND xa.estado = 'active'
               AND (xa.estado_salud NOT IN ('deslogueado', 'suspendido', 'muerto') OR xa.estado_salud IS NULL OR xa.estado_salud = 'desconocido')
               AND xa.auth_token IS NOT NULL AND xa.auth_token != ''
               AND xa.ct0 IS NOT NULL AND xa.ct0 != ''
               AND xa.id NOT IN (SELECT account_id FROM xwarmer_action_log WHERE job_id = ?)
             ORDER BY xa.ultimo_warmeo ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED`,
            [job.preconfig_id, job_id]
        );

        if (accounts.length === 0) {
            // No quedan cuentas → job completo — ajustar total al real ejecutado
            const realTotal = job.cuentas_ejecutadas;
            await connection.query(
                `UPDATE xwarmer_actions SET estado = 'Completado', completed_at = NOW(), total_cuentas = cuentas_ejecutadas WHERE id = ?`,
                [job_id]
            );
            await connection.commit();

            console.log(`[Warmer] Job ${job_id} completado: ${job.cuentas_exitosas} ok, ${job.cuentas_error} errores (real: ${realTotal})`);

            socket.send(JSON.stringify({
                type: 'warmer_done',
                job_id,
                total: realTotal,
                exitosas: job.cuentas_exitosas,
                errores: job.cuentas_error
            }));

            // Notificación Telegram
            if (job.chat_id) {
                sendTelegramNotification(
                    job.chat_id,
                    `✅ xWarmer Job #${job_id} completado\n` +
                    `Tipo: ${job.tipo}\n` +
                    `Exitosas: ${job.cuentas_exitosas}/${job.total_cuentas}\n` +
                    `Errores: ${job.cuentas_error}`
                );
            }
            return;
        }

        const account = accounts[0];

        // Cargar proxy del preconfig
        const [preconfigs] = await connection.query(
            `SELECT proxy, proxy_request FROM preconfigs WHERE id = ?`,
            [job.preconfig_id]
        );
        const proxy = preconfigs.length > 0 ? preconfigs[0].proxy : null;
        const proxy_request = preconfigs.length > 0 ? preconfigs[0].proxy_request : null;

        // Elegir nick random del grupo
        const [nicks] = await connection.query(
            `SELECT nick, tweets FROM xwarmer_nicks
             WHERE grupo = ? AND estado = 'active' AND tweets IS NOT NULL AND tweets != '[]'
             ORDER BY RAND() LIMIT 1`,
            [job.grupo_nicks]
        );

        if (nicks.length === 0) {
            await connection.commit();
            console.warn(`[Warmer] Job ${job_id}: no hay nicks activos en grupo ${job.grupo_nicks}`);
            socket.send(JSON.stringify({ type: 'warmer_done', job_id, error: 'no nicks available' }));
            return;
        }

        // Elegir tweet random
        let tweets = [];
        try {
            tweets = JSON.parse(nicks[0].tweets);
        } catch (e) {
            tweets = [];
        }

        if (!Array.isArray(tweets) || tweets.length === 0) {
            await connection.commit();
            socket.send(JSON.stringify({ type: 'warmer_done', job_id, error: 'no tweets for nick' }));
            return;
        }

        const tweet = tweets[Math.floor(Math.random() * tweets.length)];
        const tweetUrl = tweet.url || tweet;

        await connection.commit();

        console.log(`[Warmer] Job ${job_id}: cuenta @${account.nick} → @${nicks[0].nick} (${job.cuentas_ejecutadas + 1}/${job.total_cuentas})`);

        socket.send(JSON.stringify({
            type: 'warmer_target',
            job_id,
            account_id: account.id,
            auth_token: account.auth_token,
            ct0: account.ct0,
            cookies_full: account.cookies_full || null,
            proxy: proxy || null,
            proxy_request: proxy_request || null,
            nick_target: nicks[0].nick,
            url: tweetUrl,
            progress: {
                ejecutadas: job.cuentas_ejecutadas,
                total: job.total_cuentas,
                exitosas: job.cuentas_exitosas,
                errores: job.cuentas_error
            }
        }));

    } catch (err) {
        await connection.rollback();
        console.error(`[Warmer] Error en warmer_next para job ${job_id}:`, err.message);
        socket.send(JSON.stringify({ type: 'warmer_done', job_id, error: err.message }));
    } finally {
        connection.release();
    }
}

/**
 * Worker reporta resultado de una ejecución
 */
async function handleWarmerResult(socket, data) {
    const { job_id, account_id, nick_target, url, status, error_msg, error_code, set_cookies } = data;

    if (!job_id || !account_id) {
        socket.send(JSON.stringify({ type: 'warmer_result_ack', job_id, ok: false, error: 'missing params' }));
        return;
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const isSuccess = status === 'ok';

        // 1. INSERT log
        await connection.query(
            `INSERT INTO xwarmer_action_log (job_id, account_id, nick_target, url, estado, error_msg, error_code)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [job_id, account_id, nick_target || '', url || '', isSuccess ? 'Completado' : 'Error', error_msg || null, error_code || null]
        );

        // 2. UPDATE job counters
        if (isSuccess) {
            await connection.query(
                `UPDATE xwarmer_actions SET cuentas_ejecutadas = cuentas_ejecutadas + 1, cuentas_exitosas = cuentas_exitosas + 1 WHERE id = ?`,
                [job_id]
            );
        } else {
            await connection.query(
                `UPDATE xwarmer_actions SET cuentas_ejecutadas = cuentas_ejecutadas + 1, cuentas_error = cuentas_error + 1 WHERE id = ?`,
                [job_id]
            );
        }

        // 3. UPDATE xchecker_accounts
        if (isSuccess) {
            await connection.query(
                `UPDATE xchecker_accounts SET 
                    ultimo_warmeo = NOW(), ultimo_uso = NOW(),
                    fails_consecutivos = 0, estado_salud = 'activo',
                    locked = 0, locked_by = NULL, locked_at = NULL
                WHERE id = ?`,
                [account_id]
            );
        } else {
            // Analizar error para estado de salud
            let estadoSalud = 'activo';
            const errStr = (error_msg || error_code || '').toLowerCase();

            if (errStr.includes('could not authenticate') || errStr.includes('deslogueado') || errStr.includes('401')) {
                estadoSalud = 'deslogueado';
            } else if (errStr.includes('suspended') || errStr.includes('suspendido')) {
                estadoSalud = 'suspendido';
            } else if (errStr.includes('rate limit') || errStr.includes('429')) {
                estadoSalud = 'rate_limited';
            }

            await connection.query(
                `UPDATE xchecker_accounts SET 
                    ultimo_uso = NOW(),
                    fails_consecutivos = fails_consecutivos + 1,
                    ultimo_error = ?,
                    estado_salud = CASE 
                        WHEN ? != 'activo' THEN ?
                        WHEN fails_consecutivos + 1 >= 10 THEN 'muerto'
                        ELSE estado_salud
                    END,
                    locked = 0, locked_by = NULL, locked_at = NULL
                WHERE id = ?`,
                [error_msg || 'xwarmer error', estadoSalud, estadoSalud, account_id]
            );
        }

        // 4. Actualizar cookies si cambiaron
        if (set_cookies && typeof set_cookies === 'string' && set_cookies.trim().length > 0) {
            const cookieUpdates = {};
            const parts = set_cookies.split(/[;\n]/).map(s => s.trim()).filter(Boolean);
            for (const part of parts) {
                const eqIdx = part.indexOf('=');
                if (eqIdx === -1) continue;
                const key = part.substring(0, eqIdx).trim().toLowerCase();
                const val = part.substring(eqIdx + 1).trim();
                if (key === 'ct0' && val) cookieUpdates.ct0 = val;
                if (key === 'auth_token' && val) cookieUpdates.auth_token = val;
            }

            const setClauses = ['cookies_full = ?'];
            const setParams = [set_cookies];
            if (cookieUpdates.ct0) { setClauses.push('ct0 = ?'); setParams.push(cookieUpdates.ct0); }
            if (cookieUpdates.auth_token) { setClauses.push('auth_token = ?'); setParams.push(cookieUpdates.auth_token); }
            setParams.push(account_id);

            await connection.query(
                `UPDATE xchecker_accounts SET ${setClauses.join(', ')} WHERE id = ?`,
                setParams
            );
        }

        await connection.commit();

        console.log(`[Warmer] Job ${job_id}: cuenta ${account_id} → ${isSuccess ? 'OK' : 'ERROR'} (${error_code || ''})`);

        socket.send(JSON.stringify({ type: 'warmer_result_ack', job_id, ok: true }));

    } catch (err) {
        await connection.rollback();
        console.error(`[Warmer] Error en warmer_result:`, err.message);
        socket.send(JSON.stringify({ type: 'warmer_result_ack', job_id, ok: false, error: err.message }));
    } finally {
        connection.release();
    }
}

/**
 * Enviar notificación de Telegram
 */
async function sendTelegramNotification(chatId, message) {
    try {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) return;

        const payload = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
        const url = `https://api.telegram.org/bot${token}/sendMessage`;

        const https = require('https');
        const urlObj = new URL(url);

        const req = https.request({
            hostname: urlObj.hostname,
            path: urlObj.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        });
        req.write(payload);
        req.end();
    } catch (err) {
        console.error('[Warmer] Error enviando Telegram:', err.message);
    }
}

module.exports = {
    handleRequestWarmerJob,
    handleWarmerNext,
    handleWarmerResult
};
