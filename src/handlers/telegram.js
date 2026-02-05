// src/handlers/telegram.js — Notificaciones de Telegram
const db = require('../db');

async function sendCompletionNotification(actionId) {
    try {
        const [actionRows] = await db.query(`
            SELECT 
                a.url,
                a.tipo,
                a.cantidad,
                a.chatid
            FROM actions a
            WHERE a.id = ?
        `, [actionId]);

        if (actionRows.length === 0) return;

        const action = actionRows[0];
        let { url, tipo, cantidad, chatid } = action;

        let esTweet = false;
        if (tipo?.toLowerCase() === 'comentario' && url === 'https://x.com/compose/post') {
            tipo = 'tweet';
            esTweet = true;
        } else if (tipo?.toLowerCase() === 'tweet') {
            esTweet = true;
        }

        if (!chatid || chatid.toString().trim() === '') {
            // console.log(`[Telegram] Acción ${actionId} completada pero sin chatid → no se envía notificación`);
            return;
        }

        const botToken = process.env.TELEGRAM_BOT_TOKEN;

        const tipoBonito = {
            'favoritos': '❤️ Favoritos',
            'retweet': '🔁 Retweets',
            'comentario': '💬 Respuestas',
            'tweet': '📝 Tweets'
        }[tipo?.toLowerCase()] || tipo;

        const escapeMarkdown = (text) => text?.replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&') || '';

        let mensaje = `*✅ Acción completada con éxito*\n\n*Tipo:* ${tipoBonito}\n*Cantidad:* ${cantidad.toLocaleString('es-ES')}`;

        if (!esTweet && url && url !== 'https://x.com/compose/post') {
            mensaje += `\n\n*Enlace:* ${escapeMarkdown(url)}`;
        }

        const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

        const res = await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatid,
                text: mensaje.trim(),
                parse_mode: 'MarkdownV2',
                disable_web_page_preview: true
            })
        });

        const result = await res.json();
        if (result.ok) {
            // console.log(`[Telegram] Notificación enviada - Acción ${actionId} → Chat ${chatid}`);
        } else {
            console.error(`[Telegram] Error API Telegram:`, result.description || result);
        }
    } catch (err) {
        console.error(`[Telegram] Error enviando notificación acción ${actionId}:`, err.message);
    }
}

module.exports = { sendCompletionNotification };
