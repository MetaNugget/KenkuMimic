require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;
const token = process.env.TOKEN;
const commands = [];
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
  const commandsPath = path.join(foldersPath, folder);
  const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
      commands.push(command.data.toJSON());
    } else {
      console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
    }
  }
}

const rest = new REST().setToken(token);

(async () => {
  try {
    // Guild-scoped commands (GUILD_ID set) propagate instantly — use this
    // while developing. Global commands (GUILD_ID unset) can take up to an
    // hour to show up in every server, but work everywhere the bot is in.
    const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
    const scope = guildId ? `guild ${guildId}` : 'globally';

    console.log(`Started refreshing ${commands.length} application (/) commands ${scope}.`);
    const data = await rest.put(route, { body: commands });
    console.log(`Successfully reloaded ${data.length} application (/) commands ${scope}.`);
  } catch (error) {
    console.error(error);
  }
})();
