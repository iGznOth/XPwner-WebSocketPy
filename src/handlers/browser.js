// src/handlers/browser.js — Browser job handler (unlock/login)
// Uses scraping_jobs table with tipo = 'unlock' or 'login'
const db = require('../db');
const { broadcastToPanels } = require('../state');

/**
 * Worker requests a browser job (unlock or login)
 */
async function handleRequestBrowserJob(socket) {
    console.log(`[Browser] Worker ${socket.workerId} requesting browser job...`);
    
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [jobs] = await connection.query(
            `SELECT id, tipo, total, procesados, filtros
             FROM scraping_jobs
             WHERE estado = 'En Cola' AND tipo IN ('unlock', 'login')
             ORDER BY created_at ASC
             LIMIT 1
             FOR UPDATE`,
            []
        );

        if (jobs.length === 0) {
            await connection.commit();
            console.log(`[Browser] No jobs available for worker ${socket.workerId}`);
            socket.send(JSON.stringify({ type: 'no_browser_job' }));
            return;
        }

        const job = jobs[0];

        await connection.query(
            `UPDATE scraping_jobs SET estado = 'En Proceso', worker_id = ?, started_at = NOW() WHERE id = ?`,
            [socket.workerId, job.id]
        );

        await connection.commit();

        console.log(`[Browser] Job ${job.id} (${job.tipo}) assigned to worker ${socket.workerId}`);

        socket.send(JSON.stringify({
            type: 'browser_job',
            job: {
                id: job.id,
                tipo: job.tipo,
                total: job.total,
                procesados: job.procesados,
                filtros: typeof job.filtros === 'string' ? JSON.parse(job.filtros) : job.filtros
            }
        }));
    } catch (err) {
        await connection.rollback();
        console.error('[Browser] Error assigning job:', err.message);
        socket.send(JSON.stringify({ type: 'no_browser_job', reason: 'db_error' }));
    } finally {
        connection.release();
    }
}

/**
 * Worker requests next account for unlock job
 */
async function handleUnlockNext(socket, data) {
    const { job_id } = data;
    if (!job_id) {
        socket.send(JSON.stringify({ type: 'unlock_done', job_id: 0, error: 'missing job_id' }));
        return;
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [jobRows] = await connection.query(
            `SELECT * FROM scraping_jobs WHERE id = ? FOR UPDATE`,
            [job_id]
        );

        if (jobRows.length === 0) {
            await connection.commit();
            socket.send(JSON.stringify({ type: 'unlock_done', job_id, error: 'job not found' }));
            return;
        }

        const job = jobRows[0];
        const filtros = typeof job.filtros === 'string' ? JSON.parse(job.filtros) : (job.filtros || {});
        const lastId = filtros._last_id || 0;

        // Get next account matching filters
        let query = `
            SELECT xa.id, xa.nick, xa.auth_token, xa.ct0, xa.cookies_full, p.proxy
            FROM xchecker_accounts xa
            LEFT JOIN preconfigs p ON xa.deck_id = p.id
            WHERE xa.auth_token IS NOT NULL AND xa.auth_token != ''
              AND xa.ct0 IS NOT NULL AND xa.ct0 != ''
              AND xa.id > ?
        `;
        const params = [lastId];

        // Apply filters from job
        if (filtros.nombre) {
            query += ` AND xa.nombre = ?`;
            params.push(filtros.nombre);
        }
        if (filtros.deck_id) {
            query += ` AND xa.deck_id = ?`;
            params.push(filtros.deck_id);
        }
        if (filtros.estado) {
            query += ` AND xa.estado = ?`;
            params.push(filtros.estado);
        }
        if (filtros.estado_salud) {
            query += ` AND xa.estado_salud = ?`;
            params.push(filtros.estado_salud);
        }
        if (filtros.account_id) {
            query += ` AND xa.id = ?`;
            params.push(filtros.account_id);
        }

        query += ` ORDER BY xa.id ASC LIMIT 1`;

        const [accounts] = await connection.query(query, params);

        if (accounts.length === 0) {
            // No more accounts — mark job complete
            await connection.query(
                `UPDATE scraping_jobs SET estado = 'Completado', completed_at = NOW() WHERE id = ?`,
                [job_id]
            );
            await connection.commit();

            console.log(`[Browser] Unlock job ${job_id} completed`);
            socket.send(JSON.stringify({ type: 'unlock_done', job_id }));

            // Notify panels
            broadcastToPanels(socket.userId, {
                type: 'browser_job_complete',
                job_id: job_id,
                job_type: 'unlock'
            });
            return;
        }

        const account = accounts[0];

        // Update last_id in filtros
        filtros._last_id = account.id;
        await connection.query(
            `UPDATE scraping_jobs SET filtros = ? WHERE id = ?`,
            [JSON.stringify(filtros), job_id]
        );

        await connection.commit();

        socket.send(JSON.stringify({
            type: 'unlock_account',
            job_id: job_id,
            account: {
                id: account.id,
                nick: account.nick,
                auth_token: account.auth_token,
                ct0: account.ct0,
                cookies_full: account.cookies_full,
                proxy: account.proxy
            }
        }));
    } catch (err) {
        await connection.rollback();
        console.error('[Browser] Error getting next unlock account:', err.message);
        socket.send(JSON.stringify({ type: 'unlock_done', job_id, error: 'db_error' }));
    } finally {
        connection.release();
    }
}

/**
 * Worker reports unlock result
 */
async function handleUnlockResult(socket, data) {
    const { job_id, account_id, nick, status, new_auth_token, new_ct0 } = data;

    try {
        // Update account based on result
        if (status === 'unlocked') {
            // Success — set estado_salud back to activo
            await db.query(
                `UPDATE xchecker_accounts SET estado_salud = 'activo', updated_at = NOW() WHERE id = ?`,
                [account_id]
            );
            console.log(`[Browser] @${nick} unlocked successfully`);
        } else if (status === 'token_dead') {
            // Token dead — mark as deslogueado
            await db.query(
                `UPDATE xchecker_accounts SET estado_salud = 'deslogueado', updated_at = NOW() WHERE id = ?`,
                [account_id]
            );
            console.log(`[Browser] @${nick} token dead`);
        } else if (status === 'suspended') {
            // Suspended — mark as suspendido
            await db.query(
                `UPDATE xchecker_accounts SET estado_salud = 'suspendido', estado = 'inactive', updated_at = NOW() WHERE id = ?`,
                [account_id]
            );
            console.log(`[Browser] @${nick} suspended`);
        } else if (status === 'appeals') {
            // Permanently locked — needs manual appeal
            await db.query(
                `UPDATE xchecker_accounts SET estado_salud = 'appeals', estado = 'inactive', updated_at = NOW() WHERE id = ?`,
                [account_id]
            );
            console.log(`[Browser] @${nick} permanently locked (needs appeal)`);
        } else if (status === 'dead') {
            // Dead — irrecoverable account (no reset methods, appeals redirect, etc.)
            await db.query(
                `UPDATE xchecker_accounts SET estado_salud = 'dead', estado = 'inactive', updated_at = NOW() WHERE id = ?`,
                [account_id]
            );
            console.log(`[Browser] @${nick} dead (irrecoverable)`);
        } else {
            // Other failure — keep as locked, maybe increment fails
            console.log(`[Browser] @${nick} unlock failed: ${status}`);
        }

        // Update job progress
        await db.query(
            `UPDATE scraping_jobs 
             SET procesados = procesados + 1,
                 exitosos = exitosos + IF(? = 'unlocked', 1, 0),
                 errores = errores + IF(? != 'unlocked', 1, 0)
             WHERE id = ?`,
            [status, status, job_id]
        );

        // Broadcast update to panels
        broadcastToPanels(socket.userId, {
            type: 'xchecker_update',
            account_id: account_id,
            estado_salud: status === 'unlocked' ? 'activo' : 
                          status === 'token_dead' ? 'deslogueado' :
                          status === 'suspended' ? 'suspendido' :
                          status === 'appeals' ? 'appeals' :
                          status === 'dead' ? 'dead' : 'locked'
        });

        socket.send(JSON.stringify({ type: 'unlock_result_ack', account_id, status }));
    } catch (err) {
        console.error('[Browser] Error saving unlock result:', err.message);
    }
}

/**
 * Worker requests next account for login job
 */
async function handleLoginNext(socket, data) {
    const { job_id } = data;
    if (!job_id) {
        socket.send(JSON.stringify({ type: 'login_done', job_id: 0, error: 'missing job_id' }));
        return;
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [jobRows] = await connection.query(
            `SELECT * FROM scraping_jobs WHERE id = ? FOR UPDATE`,
            [job_id]
        );

        if (jobRows.length === 0) {
            await connection.commit();
            socket.send(JSON.stringify({ type: 'login_done', job_id, error: 'job not found' }));
            return;
        }

        const job = jobRows[0];
        const filtros = typeof job.filtros === 'string' ? JSON.parse(job.filtros) : (job.filtros || {});
        const lastId = filtros._last_id || 0;

        // Get next account that needs login
        let query = `
            SELECT xa.id, xa.nick, xa.password, xa.email, xa.password_email, 
                   xa.base_2fa, xa.phone, p.proxy
            FROM xchecker_accounts xa
            LEFT JOIN preconfigs p ON xa.deck_id = p.id
            WHERE xa.password IS NOT NULL AND xa.password != ''
              AND xa.id > ?
        `;
        const params = [lastId];

        // Apply filters from job
        if (filtros.nombre) {
            query += ` AND xa.nombre = ?`;
            params.push(filtros.nombre);
        }
        if (filtros.deck_id) {
            query += ` AND xa.deck_id = ?`;
            params.push(filtros.deck_id);
        }
        if (filtros.estado) {
            query += ` AND xa.estado = ?`;
            params.push(filtros.estado);
        }
        if (filtros.estado_salud) {
            query += ` AND xa.estado_salud = ?`;
            params.push(filtros.estado_salud);
        } else {
            // Default: deslogueado or no auth_token
            query += ` AND (xa.estado_salud = 'deslogueado' OR xa.auth_token IS NULL OR xa.auth_token = '')`;
        }
        if (filtros.account_id) {
            query += ` AND xa.id = ?`;
            params.push(filtros.account_id);
        }

        query += ` ORDER BY xa.id ASC LIMIT 1`;

        const [accounts] = await connection.query(query, params);

        if (accounts.length === 0) {
            // No more accounts — mark job complete
            await connection.query(
                `UPDATE scraping_jobs SET estado = 'Completado', completed_at = NOW() WHERE id = ?`,
                [job_id]
            );
            await connection.commit();

            console.log(`[Browser] Login job ${job_id} completed`);
            socket.send(JSON.stringify({ type: 'login_done', job_id }));

            broadcastToPanels(socket.userId, {
                type: 'browser_job_complete',
                job_id: job_id,
                job_type: 'login'
            });
            return;
        }

        const account = accounts[0];

        // Update last_id in filtros
        filtros._last_id = account.id;
        await connection.query(
            `UPDATE scraping_jobs SET filtros = ? WHERE id = ?`,
            [JSON.stringify(filtros), job_id]
        );

        await connection.commit();

        socket.send(JSON.stringify({
            type: 'login_account',
            job_id: job_id,
            account: {
                id: account.id,
                nick: account.nick,
                password: account.password,
                email: account.email,
                email_pw: account.password_email,
                totp: account.base_2fa,
                phone: account.phone,
                proxy: account.proxy
            }
        }));
    } catch (err) {
        await connection.rollback();
        console.error('[Browser] Error getting next login account:', err.message);
        socket.send(JSON.stringify({ type: 'login_done', job_id, error: 'db_error' }));
    } finally {
        connection.release();
    }
}

/**
 * Worker reports login result
 */
async function handleLoginResult(socket, data) {
    const { job_id, account_id, nick, status, new_auth_token, new_ct0 } = data;

    try {
        if (status === 'ok' && new_auth_token && new_ct0) {
            // Success — update tokens and estado_salud
            await db.query(
                `UPDATE xchecker_accounts 
                 SET auth_token = ?, ct0 = ?, estado_salud = 'activo', updated_at = NOW() 
                 WHERE id = ?`,
                [new_auth_token, new_ct0, account_id]
            );
            console.log(`[Browser] @${nick} logged in successfully`);
        } else if (status === 'suspended') {
            await db.query(
                `UPDATE xchecker_accounts SET estado_salud = 'suspendido', estado = 'inactive', updated_at = NOW() WHERE id = ?`,
                [account_id]
            );
            console.log(`[Browser] @${nick} suspended`);
        } else if (status === 'blocked') {
            await db.query(
                `UPDATE xchecker_accounts SET estado_salud = 'locked', updated_at = NOW() WHERE id = ?`,
                [account_id]
            );
            console.log(`[Browser] @${nick} blocked/locked`);
        } else {
            // Other failure
            console.log(`[Browser] @${nick} login failed: ${status}`);
        }

        // Update job progress
        await db.query(
            `UPDATE scraping_jobs 
             SET procesados = procesados + 1,
                 exitosos = exitosos + IF(? = 'ok', 1, 0),
                 errores = errores + IF(? != 'ok', 1, 0)
             WHERE id = ?`,
            [status, status, job_id]
        );

        // Broadcast update to panels
        broadcastToPanels(socket.userId, {
            type: 'xchecker_update',
            account_id: account_id,
            estado_salud: status === 'ok' ? 'activo' : 
                          status === 'suspended' ? 'suspendido' :
                          status === 'blocked' ? 'locked' : 'deslogueado'
        });

        socket.send(JSON.stringify({ type: 'login_result_ack', account_id, status }));
    } catch (err) {
        console.error('[Browser] Error saving login result:', err.message);
    }
}

module.exports = {
    handleRequestBrowserJob,
    handleUnlockNext,
    handleUnlockResult,
    handleLoginNext,
    handleLoginResult
};
