// Ask North Bergen - Chat Function
// Proxies the Anthropic API, redacts PII before logging, flags conversations for review.

const fs = require("fs");
const path = require("path");

// Load system prompt once at module init (cached across warm Lambda invocations)
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "SYSTEM_PROMPT.md"),
  "utf-8"
);

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";

// Restrict CORS to known origins. Add custom domains here as you wire them up.
const ALLOWED_ORIGINS = [
  "https://ask-north-bergen.netlify.app"
];

// PII patterns: redact before any logging
const PII_PATTERNS = [
  { regex: /\b\d{3}-\d{2}-\d{4}\b/g, label: "[SSN-REDACTED]" },
  { regex: /\b\d{9}\b/g, label: "[POSSIBLE-SSN-REDACTED]" },
  { regex: /\b(?:\d[ -]*?){13,16}\b/g, label: "[CC-REDACTED]" },
  { regex: /\b\d{1,2}\/\d{1,2}\/(?:19|20)\d{2}\b/g, label: "[DOB-REDACTED]" }
];

function redactPII(text) {
  let cleaned = text;
  for (const p of PII_PATTERNS) {
    cleaned = cleaned.replace(p.regex, p.label);
  }
  return cleaned;
}

// Anthropic requires alternating user/assistant messages with specific role names.
// 1. Translate frontend "bot" role to API "assistant"
// 2. Collapse runs of same role (defensive against broken sequences)
// 3. Cap to last 20 turns to prevent runaway token costs
// 4. Ensure first message is from user
function normalizeMessages(messages) {
  // Translate roles
  const translated = messages.map(m => ({
    role: m.role === "bot" ? "assistant" : m.role,
    content: m.content || ""
  }));
  
  // Collapse consecutive same-role messages, keeping the most recent
  const collapsed = [];
  for (const m of translated) {
    if (collapsed.length && collapsed[collapsed.length - 1].role === m.role) {
      collapsed[collapsed.length - 1] = m;
    } else {
      collapsed.push(m);
    }
  }
  
  // Trim leading non-user messages
  while (collapsed.length && collapsed[0].role !== "user") collapsed.shift();
  
  // Cap to last 20 turns to prevent unbounded token costs
  return collapsed.slice(-20);
}

// Retry wrapper for transient Anthropic API failures (529 overloaded, network blips)
async function callAnthropicWithRetry(payload, apiKey, maxRetries = 1) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(payload)
    });
    
    // Retry on transient errors only
    if (!response.ok && (response.status === 529 || response.status === 503) && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    return response;
  }
}

// Conversation flagging for the monthly review report
function flagConversation(messages, response) {
  const allText = [...messages.map(m => m.content), response].join(" ").toLowerCase();
  const flags = [];
  if (/\b911\b|emergency|fire|chest pain|breaking in|gas leak/i.test(allText)) flags.push("emergency");
  if (/988|suicide|self.harm|kill myself|don't want to be here/i.test(allText)) flags.push("crisis");
  if (/domestic violence|hits me|abuse|womensrising/i.test(allText)) flags.push("dv");
  if (/\bssn\b|social security|credit card/i.test(allText)) flags.push("pii-attempted");
  if (/township main line|real person|201-392-2000/i.test(response.toLowerCase())) flags.push("escape-hatch");
  if (/i don't have|no tengo/i.test(response.toLowerCase())) flags.push("dont-know");
  return flags;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";
  const allowed = ALLOWED_ORIGINS.includes(origin);

  const corsHeaders = allowed
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin"
      }
    : { "Vary": "Origin" };
  
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: allowed ? 204 : 403, headers: corsHeaders, body: "" };
  }
  
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  }

  if (!allowed) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: "Origin not allowed" }) };
  }
  
  try {
    const { messages, language, timestamp } = JSON.parse(event.body || "{}");
    
    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing messages" })
      };
    }
    
    // Cap input length to prevent abuse
    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg?.content?.length > 2000) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          response: language === "es"
            ? "Trabajo mejor con una pregunta del municipio a la vez. ¿En qué le puedo ayudar?"
            : "I work best with one township question at a time. What can I help you find?"
        })
      };
    }
    
    // Time-of-day context for off-hours awareness
    const now = new Date(timestamp || Date.now());
    const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const hour = nyTime.getHours();
    const day = nyTime.getDay();
    const isOffHours = day === 0 || day === 6 || hour < 8 || hour >= 17;
    
    const contextualPrompt = SYSTEM_PROMPT + 
      `\n\n## CURRENT CONTEXT\n` +
      `Time: ${nyTime.toLocaleString("en-US", { timeZone: "America/New_York" })} ET\n` +
      `Off-hours: ${isOffHours ? "YES, most township offices are closed" : "NO, within business hours"}\n` +
      `User language preference: ${language}`;
    
    const cleanMessages = normalizeMessages(messages);
    
    const apiResponse = await callAnthropicWithRetry({
      model: MODEL,
      max_tokens: 1500,
      system: contextualPrompt,
      messages: cleanMessages
    }, process.env.ANTHROPIC_API_KEY);
    
    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      console.error("Anthropic API error:", apiResponse.status, errText);
      throw new Error(`API error: ${apiResponse.status}`);
    }
    
    const data = await apiResponse.json();
    const responseText = data.content?.[0]?.text || "";
    
    if (!responseText) throw new Error("Empty response from API");
    
    // Log conversation (with PII redaction) for OPRA compliance + monthly review
    const flags = flagConversation(messages, responseText);
    const logEntry = {
      timestamp: now.toISOString(),
      language,
      flags,
      messages: messages.map(m => ({
        role: m.role,
        content: redactPII(m.content)
      })),
      response: redactPII(responseText)
    };
    console.log("CONVERSATION_LOG", JSON.stringify(logEntry));
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ response: responseText, flags })
    };
  } catch (err) {
    console.error("Handler error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Server error" })
    };
  }
};
