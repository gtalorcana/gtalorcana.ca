/**
 * GTA Lorcana — Cloudflare Worker
 *
 * Flow:
 *   Discord #announcements message
 *     → Discord Webhook (outgoing) hits this Worker
 *     → Worker validates the request
 *     → Worker updates announcements.json in your GitHub repo
 *     → Your site fetches announcements.json and displays it live
 *
 * Environment variables to set in Cloudflare Worker dashboard:
 *   DISCORD_WEBHOOK_SECRET  — a secret string YOU choose (used to verify requests)
 *   GITHUB_TOKEN            — a GitHub Personal Access Token (repo scope)
 *   GITHUB_OWNER            — your GitHub username
 *   GITHUB_REPO             — your GitHub Pages repo name (e.g. "gta-lorcana")
 *   GITHUB_FILE_PATH        — path in repo for the JSON file (e.g. "data/announcements.json")
 *   ANNOUNCEMENTS_CHANNEL   — Discord channel name to listen to (e.g. "announcements")
 *   MAX_ANNOUNCEMENTS       — max items to keep (e.g. "10")
 */

const GITHUB_API = 'https://api.github.com';
const GITHUB_BRANCH = 'main'; // or 'gh-pages' — wherever your site lives

export default {
  async fetch(request, env) {

    // ── Only accept POST ──────────────────────────────────
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // ── Validate secret header ────────────────────────────
    const secret = request.headers.get('X-Worker-Secret');
    if (!secret || secret !== env.DISCORD_WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    // ── Parse Discord message payload ─────────────────────
    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    // Ignore bot messages and empty content
    if (payload.author?.bot) {
      return new Response('Ignored (bot)', { status: 200 });
    }
    if (!payload.content && (!payload.embeds || payload.embeds.length === 0) && payload.action !== 'delete') {
      return new Response('Ignored (empty)', { status: 200 });
    }

    // Only listen to the configured channel
    if (env.ANNOUNCEMENTS_CHANNEL) {
      const channelName = payload.channel_name || '';
      if (channelName && channelName !== env.ANNOUNCEMENTS_CHANNEL) {
        return new Response('Ignored (wrong channel)', { status: 200 });
      }
    }

    // ── Shared GitHub config ──────────────────────────────
    const fileUrl = `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${env.GITHUB_FILE_PATH}`;
    const headers = {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'GTA-Lorcana-Worker',
    };

    // ── Handle delete action ──────────────────────────────
    if (payload.action === 'delete') {
      let existingAnnouncements = [];
      let fileSha = null;

      try {
        const res = await fetch(`${fileUrl}?ref=${GITHUB_BRANCH}`, { headers });
        if (res.ok) {
          const data = await res.json();
          fileSha = data.sha;
          const decoded = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
          existingAnnouncements = JSON.parse(decoded);
        }
      } catch {
        return new Response('Could not read announcements.json', { status: 500 });
      }

      const before = existingAnnouncements.length;
      const updated = existingAnnouncements.filter(a => a.id !== payload.id);

      if (updated.length === before) {
        // Message not found — already gone or never stored
        return new Response(JSON.stringify({ ok: true, note: 'not found' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const body = {
        message: `🗑 Deleted announcement: ${payload.id}`,
        content: btoa(unescape(encodeURIComponent(JSON.stringify(updated, null, 2)))),
        branch: GITHUB_BRANCH,
        sha: fileSha,
      };

      const writeRes = await fetch(fileUrl, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!writeRes.ok) {
        const err = await writeRes.text();
        console.error('GitHub delete write failed:', err);
        return new Response('GitHub write failed', { status: 500 });
      }

      return new Response(JSON.stringify({ ok: true, deleted: payload.id }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Build announcement object ─────────────────────────
    const announcement = {
      id: payload.id || Date.now().toString(),
      title: extractTitle(payload.content || payload.embeds?.[0]?.title || ''),
      text: cleanContent(payload.content || payload.embeds?.[0]?.description || ''),
      author: payload.author?.username || 'GTA Lorcana',
      date: new Date(payload.timestamp || Date.now()).toLocaleDateString('en-CA', {
        year: 'numeric', month: 'long', day: 'numeric'
      }),
      timestamp: payload.timestamp || new Date().toISOString(),
      icon: pickIcon(payload.content || ''),
    };

    // ── Read existing announcements.json from GitHub ──────
    let existingAnnouncements = [];
    let fileSha = null;

    try {
      const res = await fetch(`${fileUrl}?ref=${GITHUB_BRANCH}`, { headers });
      if (res.ok) {
        const data = await res.json();
        fileSha = data.sha;
        const decoded = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
        existingAnnouncements = JSON.parse(decoded);
      }
      // If 404, file doesn't exist yet — we'll create it
    } catch {
      existingAnnouncements = [];
    }

    // ── Prepend new announcement, cap at MAX_ANNOUNCEMENTS ─
    const maxItems = parseInt(env.MAX_ANNOUNCEMENTS || '10', 10);
    const updated = [announcement, ...existingAnnouncements].slice(0, maxItems);

    // ── Write back to GitHub (with retry on 409 conflict) ─
    let writeSuccess = false;
    let retries = 3;
    let currentSha = fileSha;
    let currentUpdated = updated;

    while (retries > 0) {
      const body = {
        message: `📣 New announcement: ${announcement.title}`,
        content: btoa(unescape(encodeURIComponent(JSON.stringify(currentUpdated, null, 2)))),
        branch: GITHUB_BRANCH,
      };
      if (currentSha) body.sha = currentSha;

      const writeRes = await fetch(fileUrl, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (writeRes.ok) { writeSuccess = true; break; }

      const err = await writeRes.text();

      if (writeRes.status === 409) {
        // Conflict — re-fetch latest SHA and retry
        retries--;
        if (retries === 0) {
          console.error('GitHub write failed after retries:', err);
          return new Response('GitHub write failed', { status: 500 });
        }
        await new Promise(r => setTimeout(r, 500));
        try {
          const freshRes = await fetch(`${fileUrl}?ref=${GITHUB_BRANCH}`, { headers });
          if (freshRes.ok) {
            const freshData = await freshRes.json();
            currentSha = freshData.sha;
            const freshDecoded = decodeURIComponent(escape(atob(freshData.content.replace(/\n/g, ''))));
            const freshList = JSON.parse(freshDecoded);
            currentUpdated = [announcement, ...freshList.filter(a => a.id !== announcement.id)].slice(0, maxItems);
          }
        } catch {}
        continue;
      }

      console.error('GitHub write failed:', err);
      return new Response('GitHub write failed', { status: 500 });
    }

    return new Response(JSON.stringify({ ok: true, announcement }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/* ── Helpers ─────────────────────────────────────────────── */

function extractTitle(content) {
  // Use first line or first sentence as title
  const firstLine = content.split('\n')[0].replace(/[*_#`]/g, '').trim();
  return firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
}

function cleanContent(content) {
  // Strip Discord markdown for display
  return content
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/^#+\s/gm, '')
    .trim();
}

function pickIcon(content) {
  const lower = content.toLowerCase();
  if (lower.includes('tournament') || lower.includes('champion')) return '🏆';
  if (lower.includes('draft'))                                        return '🎴';
  if (lower.includes('event') || lower.includes('casual'))           return '📅';
  if (lower.includes('welcome') || lower.includes('new'))            return '🌟';
  if (lower.includes('result') || lower.includes('winner'))          return '🥇';
  if (lower.includes('partner') || lower.includes('store'))          return '🤝';
  return '📣';
}
