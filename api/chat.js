// api/chat.js
// This runs on Vercel's servers, NOT in the browser — so the API key
// below is never visible to anyone using the app.
//
// Setup: in your Vercel project, go to Settings -> Environment Variables
// and add:
//   OPENROUTER_API_KEY  — your real OpenRouter key
//   ACCESS_CODE         — a password you make up and share only with friends
// (If ACCESS_CODE isn't set, the check below is skipped — useful while testing.)

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

  const { model, messages, reasoning, tools, plugins, stream } = req.body || {};
  if (!model || !messages) {
    return res.status(400).json({ error: 'Missing model or messages in request.' });
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
      body: JSON.stringify({ model, messages, reasoning, tools, plugins, stream: !!stream })
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
