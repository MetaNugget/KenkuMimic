require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');
const sessionState = require('./lib/sessionState');

const token = process.env.TOKEN;

// Guilds for basic guild/channel caching, GuildVoiceStates so the client can
// see who's in a voice channel and @discordjs/voice can track the
// connection — neither is a privileged intent, nothing to enable in the
// Developer Portal.
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.commands = new Collection();
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
  const commandsPath = path.join(foldersPath, folder);
  const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
      client.commands.set(command.data.name, command);
    } else {
      console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
    }
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    const errorReply = { content: '🐦‍⬛ Something in the flock went sideways — try that again in a bit.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errorReply);
    } else {
      await interaction.reply(errorReply);
    }
  }
});

// A crashed or killed process leaves sessionState's in-memory tracking gone
// with nothing to close a running GPU instance (see selfhosted.js's own
// safety-net timer, which this complements but doesn't replace — that one
// covers a hung session in a live process, this covers a clean pm2
// restart/stop). Bounded to 8s so a hung network call during shutdown can't
// block the process from exiting.
async function shutdown(signal) {
  const sessions = sessionState.getAllSessions();
  console.log(`[index] received ${signal}, cleaning up ${sessions.length} active session(s)...`);

  const cleanup = Promise.all(
    sessions.map(async ([guildId, session]) => {
      try {
        await session.transcriptionAdapter?.close();
        await session.voiceCapture?.stop();
      } catch (err) {
        console.error(`[index] cleanup error for guild ${guildId}:`, err.message);
      }
    }),
  );
  await Promise.race([cleanup, new Promise((resolve) => setTimeout(resolve, 8000))]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => {
  await client.login(token);
})();
