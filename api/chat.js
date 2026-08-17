// api/chat.js
// This runs on Vercel's servers, NOT in the browser — so the API keys
// below are never visible to anyone using the app.
//
// Setup: in your Vercel project, go to Settings -> Environment Variables
// and add:
//   OPENROUTER_API_KEY  — your real OpenRouter key
//   ACCESS_CODE         — a password you make up and share only with friends
//   TAVILY_API_KEY      — (optional) from tavily.com, 1,000 searches/month free
//   BRAVE_API_KEY       — (optional) from brave.com/search/api, 2,000/month free
//   SEARXNG_URL         — (optional) a public SearXNG instance base URL that
//                          allows format=json, e.g. https://searx.be
//                          Many public instances disable JSON output to stop
//                          scraping — if searches silently stop working, this
//                          is usually why. Test the instance directly first:
//                          <instance>/search?q=test&format=json
// (If ACCESS_CODE isn't set, the check below is skipped — useful while testing.)
//
// Web search used to be OpenRouter's own 'web' plugin (body.plugins =
// [{id:'web'}]). That plugin bills against OpenRouter credits — which is
// exactly what the 402 "Insufficient credits" error was about. Free
// OpenRouter models don't waive that charge; the search plugin is billed
// separately from the model itself.
//
// Instead, when the client sends { webSearch: true }, this file does the
// searching itself, for free, by trying three providers in order:
//   1. Tavily   — built for feeding LLMs, cleanest results, 1,000/mo free
//   2. Brave    — raw results, needs more parsing, 2,000/mo free
//   3. SearXNG  — unlimited, no signup, but public instances are less
//                 reliable and some block the JSON API entirely
// The first one that returns usable results wins; if all three fail, the
// chat continues without search results rather than erroring out. This is
// a fallback chain, not "use all three at once" — running three searches
// in parallel and merging them would mostly add latency and duplicate
// results for no real benefit, since Tavily's results are already tuned
// for this use case. The chain just means one provider running out of
// free quota doesn't take search down until the next one also runs out.

const SEARXNG_DEFAULT = 'https://searx.be';

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function searchTavily(query) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;
  const resp = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: 'basic',
      max_results: 4
    })
  }, 6000);
  if (!resp.ok) throw new Error(`Tavily ${resp.status}`);
  const data = await resp.json();
  const results = (data.results || []).map(r => ({
    title: r.title || '',
    url: r.url,
    snippet: (r.content || '').slice(0, 300)
  })).filter(r => r.url);
  if (!results.length) throw new Error('Tavily: no results');
  return { provider: 'Tavily', results };
}

async function searchBrave(query) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return null;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=4`;
  const resp = await fetchWithTimeout(url, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': key
    }
  }, 6000);
  if (!resp.ok) throw new Error(`Brave ${resp.status}`);
  const data = await resp.json();
  const results = (data.web?.results || []).slice(0, 4).map(r => ({
    title: r.title || '',
    url: r.url,
    snippet: (r.description || '').replace(/<\/?strong>/g, '').slice(0, 300)
  })).filter(r => r.url);
  if (!results.length) throw new Error('Brave: no results');
  return { provider: 'Brave', results };
}

async function searchSearxng(query) {
  const base = process.env.SEARXNG_URL || SEARXNG_DEFAULT;
  const url = `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  const resp = await fetchWithTimeout(url, {
    headers: { 'Accept': 'application/json' }
  }, 6000);
  if (!resp.ok) throw new Error(`SearXNG ${resp.status}`);
  const data = await resp.json();
  const results = (data.results || []).slice(0, 4).map(r => ({
    title: r.title || '',
    url: r.url,
    snippet: (r.content || '').slice(0, 300)
  })).filter(r => r.url);
  if (!results.length) throw new Error('SearXNG: no results');
  return { provider: 'SearXNG', results };
}

async function runWebSearch(query) {
  const providers = [searchTavily, searchBrave, searchSearxng];
  for (const provider of providers) {
    try {
      const outcome = await provider(query);
      if (outcome) return outcome; // null means "no key configured", not a failure — try the next one
    } catch (err) {
      // This provider is out of quota / down / rejected the request —
      // fall through to the next one in the chain.
      console.warn(`[web search] ${provider.name} failed: ${err.message}`);
    }
  }
  return null; // every configured provider failed — caller continues without search
}

function buildSearchContextMessage(query, outcome) {
  const lines = outcome.results.map((r, i) =>
    `${i + 1}. ${r.title || r.url}\n   ${r.snippet}\n   URL: ${r.url}`
  );
  return {
    role: 'system',
    content:
      `Live web search results for "${query}" (via ${outcome.provider}). ` +
      `Use them if they're relevant to the user's message; cite sources as [1], [2] etc. ` +
      `matching the numbers below. If they're not relevant, ignore them and answer normally.\n\n` +
      lines.join('\n')
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const requiredCode = process.env.ACCESS_CODE;
  const givenCode = req.headers['x-access-code'];
  if (requiredCode && givenCode !== requiredCode) {
    return res.status(401).json({ error: 'Invalid access code.' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'OPENROUTER_API_KEY is not set on the server. Add it in Vercel → Settings → Environment Variables.'
    });
  }

  const { model, messages, reasoning, tools, webSearch, stream } = req.body || {};
  if (!model || !messages) {
    return res.status(400).json({ error: 'Missing model or messages in request.' });
  }

  let outboundMessages = messages;
  let searchSources = [];

  if (webSearch) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const query = (lastUser?.content || '').slice(0, 400);
    if (query.trim()) {
      let outcome = null;
      try {
        outcome = await runWebSearch(query);
      } catch (err) {
        // Shouldn't normally throw (runWebSearch catches per-provider),
        // but don't let a search bug break the chat either way.
        console.warn('[web search] unexpected error: ' + err.message);
      }
      if (outcome) {
        outboundMessages = [...messages, buildSearchContextMessage(query, outcome)];
        searchSources = outcome.results.map(r => ({ url: r.url, title: r.title }));
      }
      // If every provider failed (no keys set, all quotas used, all down),
      // outboundMessages just stays as the original messages — the chat
      // continues without search instead of erroring out.
    }
  }

  try {
    const orResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://freeai.vercel.app', // fine to leave as-is
        'X-Title': 'FreeAI'
      },
      body: JSON.stringify({ model, messages: outboundMessages, reasoning, tools, stream: !!stream })
    });

    if (stream) {
      // Pipe OpenRouter's server-sent-events straight through to the
      // browser as they arrive, instead of buffering the whole reply —
      // this is what lets the chat UI show text appearing token by token
      // instead of everyone waiting for the full response to land at once.
      res.writeHead(orResponse.status, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
      });

      if (searchSources.length) {
        // One synthetic frame ahead of OpenRouter's real stream, carrying
        // the URLs we searched so the client can render a Sources list —
        // same as before, just sourced from our own search instead of
        // OpenRouter's plugin annotations.
        res.write(`data: ${JSON.stringify({ freeai_sources: searchSources })}\n\n`);
        if (typeof res.flush === 'function') res.flush();
      }

      if (!orResponse.body) {
        res.end();
        return;
      }

      const reader = orResponse.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
          if (typeof res.flush === 'function') res.flush(); // no-op if unsupported
        }
      } finally {
        res.end();
      }
      return;
    }

    const data = await orResponse.json();
    if (searchSources.length) data._freeai_sources = searchSources;
    return res.status(orResponse.status).json(data);
  } catch (err) {
    if (stream) {
      // Headers may already be sent for a stream request — just close it
      // rather than trying to send a fresh JSON error on top.
      try { res.end(); } catch (e) {}
      return;
    }
    return res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
}
