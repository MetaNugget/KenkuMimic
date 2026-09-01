const OpenAI = require('openai');

// Anthropic, OpenAI, and most self-hosted setups (Ollama, llama.cpp server)
// all speak the same chat-completions shape, so this is the only client we
// need — which provider is actually behind it is just config.
//
// Built lazily, not at module load: the OpenAI SDK throws immediately if no
// API key is present anywhere, and this module gets require()'d by the
// command loader at bot startup — a top-level client would crash the whole
// process on boot whenever NOTES_API_KEY is unset, not just when notes
// generation is actually attempted.
let client;
function getClient() {
  if (!client) {
    client = new OpenAI({
      baseURL: process.env.NOTES_BASE_URL,
      apiKey: process.env.NOTES_API_KEY,
    });
  }
  return client;
}

const SYSTEM_PROMPT = `You produce structured session notes from a tabletop RPG session transcript.
The transcript is a plain-text log of what was said, with each line prefixed
by a timestamp and speaker. Speakers may talk over each other and the
transcript may contain transcription errors — use judgment to reconstruct
what most likely happened.

Produce notes in exactly this structure, using Markdown headers:

## Recap
A few paragraphs summarizing what happened in the session, in narrative order.

## Key Decisions
A bulleted list of decisions the party made that will matter going forward.

## NPCs Introduced
A bulleted list of any new non-player characters who appeared, with a
one-line description of each. If none appeared, write "None this session."

## Open Threads
A bulleted list of unresolved plot threads, unanswered questions, or
next-session setup.

Keep it concise. Do not invent details that aren't supported by the transcript.`;

async function generateNotes(transcriptText) {
  const response = await getClient().chat.completions.create({
    model: process.env.NOTES_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: transcriptText },
    ],
  });

  const notes = response.choices[0]?.message?.content;
  if (!notes) {
    throw new Error('Notes generation returned no content');
  }

  // Cost visibility: no live pricing lookup exists for any provider, so
  // real usage is logged here and per-session cost gets reviewed from these
  // lines rather than estimated up front.
  const usage = response.usage;
  console.log(
    `[notesClient] base_url=${process.env.NOTES_BASE_URL} model=${process.env.NOTES_MODEL} ` +
      `input_tokens=${usage?.prompt_tokens ?? 'unknown'} output_tokens=${usage?.completion_tokens ?? 'unknown'} ` +
      `total_tokens=${usage?.total_tokens ?? 'unknown'}`,
  );

  return notes;
}

module.exports = { generateNotes };
