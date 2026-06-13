const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const config = require('./config');

const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Turn 구매티켓 패널을 전송합니다 (관리자 전용)')
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(config.TOKEN);

(async () => {
  try {
    console.log('📡 슬래시 커맨드 등록 중...');
    await rest.put(
      Routes.applicationGuildCommands(config.CLIENT_ID, config.GUILD_ID),
      { body: commands }
    );
    console.log('✅ 슬래시 커맨드 등록 완료!');
  } catch (err) {
    console.error('❌ 오류:', err);
  }
})();
