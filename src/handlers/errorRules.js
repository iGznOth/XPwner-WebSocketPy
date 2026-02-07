// src/handlers/errorRules.js — Dynamic error rules cache
// Reloads from DB every 60 seconds
const db = require('../db');

let rulesCache = [];
let lastLoad = 0;
const CACHE_TTL = 60000; // 60 seconds

async function loadRules() {
    try {
        const [rows] = await db.query('SELECT * FROM error_rules WHERE enabled = 1 ORDER BY priority DESC');
        rulesCache = rows;
        lastLoad = Date.now();
        console.log(`[ErrorRules] Loaded ${rows.length} rules`);
    } catch (err) {
        console.error('[ErrorRules] Error loading rules:', err.message);
    }
}

function getRules() {
    if (Date.now() - lastLoad > CACHE_TTL) {
        loadRules();
    }
    return rulesCache;
}

function matchError(errorCode, errorMessage) {
    const rules = getRules();
    const errStr = (errorMessage || '').toLowerCase();
    const errCodeNum = parseInt(errorCode) || null;

    for (const rule of rules) {
        if (rule.code !== null && rule.code === errCodeNum) {
            return rule;
        }
        if (rule.message_pattern && errStr.includes(rule.message_pattern.toLowerCase())) {
            return rule;
        }
    }
    return null;
}

async function processError(connection, params, isWarmer) {
    const { account_id, action_id, module, error_code, error_message } = params;
    
    const rule = matchError(error_code, error_message);
    
    let actionToTake;
    let estadoSalud = null;
    let setInactive = false;
    
    if (rule) {
        actionToTake = isWarmer ? rule.action_warmer : rule.action_normal;
        estadoSalud = rule.estado_salud;
        setInactive = !!rule.set_inactive;
    } else {
        actionToTake = isWarmer ? 'skip' : 'retry_new';
        estadoSalud = null;
        setInactive = false;
    }
    
    try {
        await connection.query(
            `INSERT INTO error_log (account_id, action_id, module, error_code, error_message, rule_id, action_taken)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [account_id, action_id || null, module || null, error_code || null, 
             (error_message || '').substring(0, 2000), rule ? rule.id : null, actionToTake]
        );
    } catch (logErr) {
        console.error('[ErrorRules] Error logging:', logErr.message);
    }
    
    if (estadoSalud) {
        let updateQuery = `UPDATE xchecker_accounts SET 
            ultimo_error = ?,
            fails_consecutivos = fails_consecutivos + 1,
            estado_salud = ?`;
        let updateParams = [(error_message || '').substring(0, 500), estadoSalud];
        
        if (setInactive) {
            updateQuery += `, estado = 'inactive'`;
        }
        
        updateQuery += ` WHERE id = ?`;
        updateParams.push(account_id);
        
        await connection.query(updateQuery, updateParams);
    } else {
        await connection.query(
            `UPDATE xchecker_accounts SET 
                fails_consecutivos = fails_consecutivos + 1,
                ultimo_error = ?
            WHERE id = ?`,
            [(error_message || '').substring(0, 500), account_id]
        );
    }
    
    return { action: actionToTake, rule, estado_salud: estadoSalud };
}

loadRules();
setInterval(loadRules, CACHE_TTL);

module.exports = { loadRules, getRules, matchError, processError };
