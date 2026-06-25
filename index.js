const {
  Client,
  GatewayIntentBits,
  Partials,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  ChannelType,
  AttachmentBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
} = require('discord.js');

const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const { initFirebase, getDb } = require('./firebase');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  // v14: 문자열 'CHANNEL' 같은 거 넣으면 조용히 무시됨 → Partials enum 필수
  partials: [Partials.Channel, Partials.Message],
});

initFirebase();

let ticketCounter = 0;
const dmMap = new Map();
const closingSet = new Set();   // 중복 종료 방지
const creatingSet = new Set();  // 버튼 연타로 인한 중복 티켓 생성 방지

// 알려진 스탭 명령어 (이외의 .명령어는 유저에게 릴레이하지 않음)
const KNOWN_DOT_COMMANDS = ['.문의종료', '.강제종료', '.느린문의', '.단팩신청서'];

// ─────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────

// 유효한 스탭 역할 ID만 추림 (빈값/잘못된값/@everyone=서버ID 자동 제외)
function validStaffRoleIds() {
  return [...new Set(
    [config.STAFF_ROLE_ID, config.STAFF_ROLE_ID2, config.STAFF_ROLE_ID3]
      .filter(id =>
        typeof id === 'string' &&
        /^\d{17,20}$/.test(id) &&
        id !== config.GUILD_ID &&
        id !== config.PANEL_GUILD_ID
      )
  )];
}

// STAFF_ROLE_ID 슬롯에 'everyone' / '@everyone' / 고객센터 서버ID 를 넣으면
// → 고객센터 서버 전원에게 티켓 공개 (스탭 역할 없이 운영)
function staffEveryoneMode() {
  return [config.STAFF_ROLE_ID, config.STAFF_ROLE_ID2, config.STAFF_ROLE_ID3]
    .some(v => typeof v === 'string' && (
      v.trim().toLowerCase() === 'everyone' ||
      v.trim() === '@everyone' ||
      v.trim() === config.GUILD_ID
    ));
}

// 스탭 멘션 문자열 (everyone 모드거나 잘못된 ID면 @here 로 대체)
function staffMention() {
  const ids = validStaffRoleIds();
  if (staffEveryoneMode() || ids.length === 0) return '@here';
  return ids.map(id => `<@&${id}>`).join(' ');
}

// 2000자 제한 대응: 줄 단위로 안전 분할
function chunkContent(str, size = 1900) {
  const chunks = [];
  let cur = '';
  for (const line of String(str).split('\n')) {
    if ((cur + line + '\n').length > size) {
      if (cur) { chunks.push(cur); cur = ''; }
      if (line.length > size) {
        for (let i = 0; i < line.length; i += size) chunks.push(line.slice(i, i + size));
      } else {
        cur = line + '\n';
      }
    } else {
      cur += line + '\n';
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [''];
}

// content(긴 텍스트) + files 안전 전송. 파일은 마지막 청크에 첨부.
async function sendChunked(target, content, files = []) {
  const text = (content || '').trim();
  const chunks = text ? chunkContent(text) : [''];

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const payload = {};
    if (chunks[i]) payload.content = chunks[i];
    if (isLast && files.length) payload.files = files;
    if (!payload.content && !payload.files) continue;
    await target.send(payload);
  }
}

async function getSetting(key) {
  try {
    const doc = await getDb().collection('settings').doc(key).get();
    if (doc.exists) return doc.data().value;
  } catch {}
  return null;
}

async function setSetting(key, value) {
  await getDb().collection('settings').doc(key).set({ value });
}

// ─────────────────────────────────────────────
// 슬래시 커맨드 등록
// ─────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('panel')
      .setDescription('티켓 패널 전송 (관리자 전용)'),

    new SlashCommandBuilder()
      .setName('설정')
      .setDescription('봇 설정 변경 (관리자 전용)')
      .addStringOption(o =>
        o.setName('항목')
          .setDescription('변경할 항목')
          .setRequired(true)
          .addChoices(
            { name: '단팩신청서', value: '단팩신청서' },
            { name: '느린문의', value: '느린문의' },
          )
      )
      .addStringOption(o =>
        o.setName('내용')
          .setDescription('변경할 내용 (링크 또는 텍스트)')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('설정확인')
      .setDescription('현재 설정값 확인 (관리자 전용)'),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(config.TOKEN);
  const guildIds = [...new Set([config.GUILD_ID, config.PANEL_GUILD_ID].filter(Boolean))];
  for (const gid of guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(config.CLIENT_ID, gid), { body: commands });
      console.log(`✅ 슬래시 커맨드 등록 완료 (${gid})`);
    } catch (e) {
      console.error(`커맨드 등록 실패 (${gid}):`, e.message);
    }
  }
}

// ─────────────────────────────────────────────
// dmMap 복원 (봇 재시작 시 진행중 티켓 매핑 복구)
// ─────────────────────────────────────────────
async function restoreOpenTickets() {
  try {
    const guild = client.guilds.cache.get(config.GUILD_ID);
    const snap = await getDb().collection('tickets')
      .where('status', '==', 'open')
      .get();

    let restored = 0;
    let stale = 0;

    for (const doc of snap.docs) {
      const d = doc.data();
      if (!d.userId || !d.channelId) continue;

      // 채널이 이미 삭제됐는데 status가 open인 경우 → 정리
      const channelExists = guild?.channels.cache.has(d.channelId);
      if (!channelExists) {
        stale++;
        try {
          await getDb().collection('tickets').doc(d.ticketId).update({
            status: 'closed',
            closedAt: d.closedAt || new Date().toISOString(),
            closedBy: 'system(restart-cleanup)',
            closeType: 'stale',
          });
        } catch {}
        continue;
      }

      dmMap.set(d.userId, {
        ticketId: d.ticketId,
        channelId: d.channelId,
        type: d.type,
        typeLabel: d.typeLabel,
      });
      restored++;
    }

    console.log(`🔄 진행중 티켓 복원: ${restored}건 (정리된 stale: ${stale}건)`);
  } catch (e) {
    console.error('티켓 복원 실패:', e.message);
  }
}

// ─────────────────────────────────────────────
// Ready
// ─────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(`✅ ${client.user.tag} 온라인`);
  await registerCommands();

  try {
    const db = getDb();
    const metaDoc = await db.collection('meta').doc('counter').get();
    if (metaDoc.exists) {
      ticketCounter = metaDoc.data().value || 0;
      console.log(`📊 티켓 카운터 복원: ${ticketCounter}`);
    }
  } catch (e) {
    console.error('카운터 복원 실패:', e.message);
  }

  await restoreOpenTickets();
});

// ─────────────────────────────────────────────
// 인터랙션
// ─────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── /panel ──
  if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ 관리자만 사용 가능합니다.', flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
      .setColor(0x7c3aed)
      .setTitle('# Turn 고객센터')
      .setDescription([
        '## 고객센터 안내사항',
        '- 본 고객센터는 서버의 여러 문의를 접수하기 위한 공간입니다. 해당 채널을 악용하여 용도 이외의 방법으로 사용하는 경우 관련 규정에 따라 제재 처리될 수 있습니다.',
        '',
        '- 아래의 항목 중 해당되는 카테고리를 선택하여 고객센터 문의를 시작하세요.',
      ].join('\n'))
      .setFooter({ text: 'Turn • 문의는 언제든지 환영합니다' })
      .setTimestamp();

    const buttons = config.TICKET_OPTIONS.map(opt => {
      const btn = new ButtonBuilder()
        .setCustomId(`ticket_btn:${opt.value}`)
        .setLabel(opt.label)
        .setStyle(ButtonStyle.Primary);
      if (opt.emoji) btn.setEmoji(opt.emoji);
      return btn;
    });

    const row = new ActionRowBuilder().addComponents(buttons);
    const panelGuild = client.guilds.cache.get(config.PANEL_GUILD_ID);
    const targetChannel = panelGuild?.channels.cache.get(config.TICKET_PANEL_CHANNEL_ID);

    if (!targetChannel) {
      return interaction.reply({
        content: '❌ PANEL_GUILD_ID / TICKET_PANEL_CHANNEL_ID를 확인해주세요. (봇이 본섭에 들어가 있어야 함)',
        flags: MessageFlags.Ephemeral,
      });
    }

    await targetChannel.send({ embeds: [embed], components: [row] });
    return interaction.reply({
      content: `✅ ${targetChannel} 에 패널 전송 완료!`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /설정 ──
  if (interaction.isChatInputCommand() && interaction.commandName === '설정') {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ 관리자만 사용 가능합니다.', flags: MessageFlags.Ephemeral });
    }

    const 항목 = interaction.options.getString('항목');
    const 내용 = interaction.options.getString('내용');

    await setSetting(항목, 내용);

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle('✅ 설정 완료')
          .addFields(
            { name: '항목', value: 항목, inline: true },
            { name: '내용', value: 내용, inline: true },
          )
          .setTimestamp(),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /설정확인 ──
  if (interaction.isChatInputCommand() && interaction.commandName === '설정확인') {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ 관리자만 사용 가능합니다.', flags: MessageFlags.Ephemeral });
    }

    const [신청서, 느린] = await Promise.all([
      getSetting('단팩신청서'),
      getSetting('느린문의'),
    ]);

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x7c3aed)
          .setTitle('📋 현재 설정값')
          .addFields(
            { name: '📄 단팩신청서', value: 신청서 || '*(미설정)*', inline: false },
            { name: '🐢 느린문의', value: 느린 || '*(미설정)*', inline: false },
          )
          .setTimestamp(),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── 티켓 버튼 ──
  if (interaction.isButton() && interaction.customId.startsWith('ticket_btn:')) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const selectedValue = interaction.customId.split(':')[1];
    const option = config.TICKET_OPTIONS.find(o => o.value === selectedValue);

    if (!option) {
      return interaction.editReply({ content: '❌ 알 수 없는 옵션입니다.' });
    }

    // 버튼은 본섭에서 눌려도, 티켓은 고객센터 서버(GUILD_ID)에 생성
    const guild = client.guilds.cache.get(config.GUILD_ID);
    const member = interaction.member;

    if (!guild) {
      return interaction.editReply({ content: '❌ 고객센터 서버(GUILD_ID)를 찾을 수 없습니다. 봇이 해당 서버에 들어가 있는지 확인해주세요.' });
    }

    // 연타 방지 가드 (생성 중인 유저는 즉시 차단)
    if (creatingSet.has(member.id)) {
      return interaction.editReply({ content: '⏳ 티켓을 생성하는 중입니다. 잠시만 기다려주세요.' });
    }

    const categoryId = config.CATEGORIES[option.categoryKey];
    const category = guild.channels.cache.get(categoryId);

    if (!category) {
      return interaction.editReply({
        content: `❌ \`${option.label}\` 카테고리를 찾을 수 없습니다.`,
      });
    }

    if (dmMap.has(member.id)) {
      const existing = dmMap.get(member.id);
      const existingCh = guild.channels.cache.get(existing.channelId);
      // 매핑은 있는데 채널이 사라졌으면 매핑 정리 후 진행
      if (!existingCh) {
        dmMap.delete(member.id);
      } else {
        return interaction.editReply({
          content: `❌ 이미 진행중인 문의가 있습니다. (${existingCh})`,
        });
      }
    }

    creatingSet.add(member.id);

    try {
      ticketCounter++;
      const ticketId = uuidv4();

      try {
        await getDb().collection('meta').doc('counter').set({ value: ticketCounter });
      } catch (e) {
        console.error('카운터 저장 실패:', e);
      }

      const safeName =
        member.user.username
          .toLowerCase()
          .replace(/[^a-z0-9가-힣]/g, '')
          .slice(0, 12) || 'user';

      const channelName = `${option.channelPrefix || option.value.toLowerCase()}-${safeName}`;
      const ticketNum = String(ticketCounter).padStart(4, '0');

      const STAFF_ALLOW = [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.ManageMessages,
      ];

      const configuredStaff = validStaffRoleIds();
      const staffIds = configuredStaff.filter(id => guild.roles.cache.has(id));
      const missingStaff = configuredStaff.filter(id => !guild.roles.cache.has(id));
      const everyoneMode = staffEveryoneMode();
      if (missingStaff.length) {
        console.warn(`⚠️ 고객센터 서버(${guild.name})에 없는 역할 ID 무시: ${missingStaff.join(', ')}`);
      }
      if (!everyoneMode && staffIds.length === 0) {
        console.warn('⚠️ 유효한 스탭 설정이 없습니다. STAFF_ROLE_ID에 고객센터 서버 역할 ID를 넣거나 "everyone"으로 설정하세요.');
      }

      // everyoneMode면 @everyone 에게 열어주고, 아니면 막고 스탭 역할에만 허용
      const everyoneOverwrite = everyoneMode
        ? { id: guild.roles.everyone.id, allow: STAFF_ALLOW }
        : { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] };

      const permissionOverwrites = [
        everyoneOverwrite,
        ...staffIds.map(id => ({ id, allow: STAFF_ALLOW })),
        {
          id: client.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageChannels,
          ],
        },
      ];

      const ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: categoryId,
        topic: `ticketId:${ticketId} | userId:${member.id} | type:${option.value}`,
        permissionOverwrites,
      });

      dmMap.set(member.id, {
        ticketId,
        channelId: ticketChannel.id,
        type: option.value,
        typeLabel: option.label,
      });

      const ticketData = {
        ticketId,
        ticketNumber: ticketCounter,
        channelId: ticketChannel.id,
        channelName,
        type: option.value,
        typeLabel: option.label,
        userId: member.id,
        userTag: member.user.tag,
        userDisplayName: member.displayName,
        guildId: guild.id,
        guildName: guild.name,
        status: 'open',
        createdAt: new Date().toISOString(),
        closedAt: null,
        closedBy: null,
        messages: [],
      };

      try {
        await getDb().collection('tickets').doc(ticketId).set(ticketData);
      } catch (e) {
        console.error('티켓 생성 Firestore 저장 실패:', e);
      }

      await sendStaffGuide(ticketChannel, member, option, ticketNum, ticketId);

      try {
        const dmEmbed = new EmbedBuilder()
          .setColor(0x7c3aed)
          .setTitle(`${option.emoji ? option.emoji + ' ' : ''}${option.label} 문의 접수`)
          .setDescription(
            `안녕하세요 **${member.displayName}**님!\n\n` +
            `**[${option.label}]** 문의가 접수되었습니다 🩷\n\n` +
            `아래에 문의하실 내용을 입력해주세요.\n` +
            `스탭이 확인 후 이 DM으로 답변드리겠습니다.`
          )
          .setFooter({ text: 'Turn • 이 DM에 메시지를 보내면 스탭에게 전달됩니다' })
          .setTimestamp();

        await member.user.send({ embeds: [dmEmbed] });
      } catch {
        await ticketChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xef4444)
              .setDescription(`⚠️ **${member.user.tag}** 님의 DM이 차단되어 있어 메시지를 전송할 수 없습니다.`),
          ],
        });
      }

      logAction(guild, '🎫 티켓 생성', null, 0x22c55e, [
        { name: '유형', value: option.label, inline: true },
        { name: '생성자', value: member.user.tag, inline: true },
        { name: '채널', value: `${ticketChannel}`, inline: true },
        { name: '티켓 번호', value: `#${ticketNum}`, inline: true },
      ]);

      return interaction.editReply({
        content: '✅ 문의가 접수되었습니다! DM을 확인해주세요 🩷',
      });
    } catch (e) {
      console.error('티켓 생성 중 오류:', e);
      return interaction.editReply({ content: '❌ 티켓 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
    } finally {
      creatingSet.delete(member.id);
    }
  }
});

// ─────────────────────────────────────────────
// 스탭 채널 안내 임베드
// ─────────────────────────────────────────────
async function sendStaffGuide(ticketChannel, member, option, ticketNum, ticketId) {
  let recentList = '없음';

  try {
    const db = getDb();
    const snap = await db.collection('tickets')
      .where('userId', '==', member.id)
      .get();

    if (!snap.empty) {
      const closed = snap.docs
        .map(doc => doc.data())
        .filter(d => d.status === 'closed' && d.closedAt)
        .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
        .slice(0, 4);

      if (closed.length) {
        recentList = closed.map(d => {
          const date = new Date(d.closedAt);
          const label =
            `${String(date.getFullYear()).slice(2)}년 ` +
            `${String(date.getMonth() + 1).padStart(2, '0')}월 ` +
            `${String(date.getDate()).padStart(2, '0')}일 문의내역`;

          return `[${label}](${config.WEB_BASE_URL}ticket/${d.ticketId})`;
        }).join('\n');
      }
    }
  } catch (e) {
    console.error('최근 문의 내역 조회 실패:', e.message);
  }

  const guideEmbed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setAuthor({
      name: `${member.displayName} (${member.user.tag})`,
      iconURL: member.user.displayAvatarURL({ size: 64 }),
    })
    .setTitle('문의 관리 안내')
    .addFields(
      {
        name: '📢 문의 응대 안내',
        value: [
          '> 텍스트 앞에 `!`을 붙이면 문의자에게 발송되지 않습니다. (`예시: !@GM 도와주세요`)',
          '> 문의가 밀려 기다려야 할 경우 `.느린문의 [초]`를 입력해 주세요.',
          '> 항상 친절하고 정확하게 전달해 주세요. 모르는 사항은 담당 개발자 또는 관리자에게 질문 후 답변 부탁드립니다.',
        ].join('\n'),
        inline: false,
      },
      {
        name: '🔒 문의 종료 안내',
        value: [
          '> `.문의종료` 를 입력해 주세요.',
          '> 작동하지 않는다면 `.강제종료` 를 입력해 주세요.',
        ].join('\n'),
        inline: false,
      },
      {
        name: '⌨️ 문의 명령어 안내',
        value: [
          '> `.느린문의 [초]` — 채널 슬로우모드 설정 (예: `.느린문의 30`)',
          '> `.단팩신청서` — 단팩신청서 링크 전송',
        ].join('\n'),
        inline: false,
      },
      {
        name: '📋 최근 문의 내역',
        value: recentList,
        inline: false,
      },
    )
    .setFooter({ text: `Turn • 티켓 #${ticketNum}` })
    .setTimestamp();

  const staffEmbed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle(`${option.emoji ? option.emoji + ' ' : ''}${option.label} 티켓 #${ticketNum}`)
    .setDescription(
      `${staffMention()} 새 문의가 접수되었습니다.\n\n` +
      `> 이 채널에서 답변을 입력하면 유저의 DM으로 자동 전달됩니다.`
    )
    .addFields(
      { name: '📋 문의 유형', value: option.label, inline: true },
      { name: '👤 유저', value: `${member.user.tag}`, inline: true },
      { name: '🆔 티켓 ID', value: `\`${ticketId}\``, inline: false },
    )
    .setFooter({ text: 'Turn' })
    .setTimestamp();

  await ticketChannel.send({ content: '@here', embeds: [staffEmbed] });
  await ticketChannel.send({ embeds: [guideEmbed] });
}

// ─────────────────────────────────────────────
// 메시지 핸들러
// ─────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  // partial(캐시 안 된 DM/메시지)이면 먼저 풀어줌 — DM/첨부 제대로 받으려면 필수
  if (message.partial) {
    try { await message.fetch(); } catch { return; }
  }
  if (message.channel?.partial) {
    try { await message.channel.fetch(); } catch {}
  }

  if (message.author.bot) return;

  // ── DM: 유저 → 스탭 채널 릴레이 ──
  if (message.channel.type === ChannelType.DM) {
    const ticketInfo = dmMap.get(message.author.id);

    if (!ticketInfo) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xef4444)
            .setDescription('❌ 진행중인 문의가 없습니다.\n서버에서 티켓을 먼저 생성해주세요.'),
        ],
      });
    }

    if (message.content.trim().startsWith('.')) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xef4444)
            .setDescription('❌ 해당 명령어는 스탭만 사용 가능합니다.'),
        ],
      });
    }

    const guild = client.guilds.cache.get(config.GUILD_ID);
    if (!guild) return;

    const ticketChannel = guild.channels.cache.get(ticketInfo.channelId);
    if (!ticketChannel) {
      // 채널이 사라진 매핑 정리 + 유저 안내
      dmMap.delete(message.author.id);
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xef4444)
            .setDescription('❌ 문의 채널이 종료되었습니다. 새로 문의하시려면 서버에서 티켓을 다시 생성해주세요.'),
        ],
      });
    }

    const files = [...message.attachments.values()].map(a => a.url);
    const lines = (message.content || '').split('\n').map(line =>
      `<@${message.author.id}>(${message.author.id}) : ${line}`
    ).join('\n');

    try {
      await sendChunked(ticketChannel, lines, files);
      await message.react('✅').catch(() => {});
    } catch (e) {
      console.error('스탭 채널 릴레이 실패:', e.message);
      await message.react('⚠️').catch(() => {});
    }

    try {
      const db = getDb();
      const ticketDoc = await db.collection('tickets').doc(ticketInfo.ticketId).get();

      if (ticketDoc.exists) {
        const msgs = ticketDoc.data().messages || [];

        msgs.push({
          authorId: message.author.id,
          authorTag: message.author.tag,
          authorAvatar: message.author.displayAvatarURL({ size: 64 }),
          content: message.content || '',
          attachments: files,
          isBot: false,
          from: 'user',
          timestamp: new Date().toISOString(),
        });

        await db.collection('tickets').doc(ticketInfo.ticketId).update({ messages: msgs });
      }
    } catch (e) {
      console.error('메시지 저장 실패:', e);
    }

    return;
  }

  // ── 스탭 채널 메시지 ──
  if (message.guild && message.guild.id === config.GUILD_ID) {
    const channel = message.channel;

    if (!channel.topic || !channel.topic.includes('ticketId:')) return;

    const staffIds = validStaffRoleIds();
    const isStaff =
      staffEveryoneMode() ||
      message.member?.permissions?.has(PermissionsBitField.Flags.Administrator) ||
      staffIds.some(id => message.member?.roles.cache.has(id));

    if (!isStaff) return;

    const content = message.content.trim();
    const ticketId = channel.topic.match(/ticketId:([a-f0-9-]+)/)?.[1];
    const userId = channel.topic.match(/userId:(\d+)/)?.[1];

    // .문의종료 / !종료
    if (content === '.문의종료' || content === '!종료') {
      if (ticketId) {
        await closeTicket(channel, ticketId, message.member, null, message);
      }
      return;
    }

    // .강제종료
    if (content === '.강제종료') {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xef4444)
            .setTitle('⚠️ 강제 종료')
            .setDescription(`**${message.member.user.tag}** 님이 티켓을 강제 종료합니다.\n잠시 후 채널이 삭제됩니다.`)
            .setTimestamp(),
        ],
      });

      if (ticketId) {
        const logUrl = `${config.WEB_BASE_URL}ticket/${ticketId}`;

        try {
          await getDb().collection('tickets').doc(ticketId).update({
            status: 'closed',
            closedAt: new Date().toISOString(),
            closedBy: message.member.user.tag,
            closedById: message.member.id,
            closeType: 'force',
            logUrl,
          });
        } catch {}

        if (userId) dmMap.delete(userId);

        logAction(channel.guild, '⚠️ 티켓 강제종료', null, 0xef4444, [
          { name: '채널', value: channel.name, inline: true },
          { name: '닫은 사람', value: message.member.user.tag, inline: true },
          { name: '로그', value: logUrl, inline: false },
        ]);
      }

      setTimeout(() => channel.delete().catch(() => {}), 3000);
      return;
    }

    // .느린문의 [초]
    if (content.startsWith('.느린문의')) {
      const seconds = parseInt(content.split(' ')[1]) || 0;

      try {
        await channel.setRateLimitPerUser(seconds);

        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf59e0b)
              .setTitle('🐢 슬로우모드 설정')
              .setDescription(
                seconds === 0
                  ? '슬로우모드가 **해제**되었습니다.'
                  : `슬로우모드가 **${seconds}초**로 설정되었습니다.`
              )
              .setFooter({ text: 'Turn' })
              .setTimestamp(),
          ],
        });
      } catch (e) {
        await message.reply({ content: '⚠️ 슬로우모드 설정 실패: ' + e.message });
      }

      if (userId) {
        try {
          const user = await client.users.fetch(userId);

          await user.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xf59e0b)
                .setAuthor({
                  name: 'Turn 고객센터',
                  iconURL: client.user.displayAvatarURL(),
                })
                .setTitle('🐢 문의 대기 안내')
                .setDescription('현재 문의가 많아 답변이 다소 늦어질 수 있습니다.\n잠시만 기다려 주시면 순서대로 답변드리겠습니다 🙏')
                .setFooter({ text: 'Turn' })
                .setTimestamp(),
            ],
          });
        } catch {}
      }

      await message.react('🐢').catch(() => {});
      return;
    }

    // .단팩신청서
    if (content === '.단팩신청서') {
      const link =
        await getSetting('단팩신청서') ||
        '단팩신청서 링크가 설정되지 않았습니다. `/설정 단팩신청서`로 설정해주세요.';

      if (userId) {
        try {
          const user = await client.users.fetch(userId);

          await user.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x7c3aed)
                .setAuthor({
                  name: 'Turn 고객센터',
                  iconURL: client.user.displayAvatarURL(),
                })
                .setTitle('📄 단팩신청서')
                .setDescription(`아래 링크를 통해 단팩신청서를 작성해주세요.\n\n${link}`)
                .setFooter({ text: 'Turn' })
                .setTimestamp(),
            ],
          });
        } catch {}
      }

      await message.react('📄').catch(() => {});
      return;
    }

    // ! 내부 메시지 (유저에게 전달 안 함)
    if (content.startsWith('!')) {
      return;
    }

    // 알 수 없는 .명령어는 유저에게 릴레이하지 않음 (오발송 방지)
    if (content.startsWith('.') && !KNOWN_DOT_COMMANDS.some(c => content.startsWith(c))) {
      await message.react('❓').catch(() => {});
      return;
    }

    // 일반 스탭 답변
    if (!userId) return;

    try {
      const user = await client.users.fetch(userId);
      const fileAttachments = [...message.attachments.values()].map(
        a => new AttachmentBuilder(a.url, { name: a.name })
      );

      const staffLines = (message.content || '').split('\n').map(line =>
        `[관리자] ${message.member.displayName}: ${line}`
      ).join('\n');

      await sendChunked(user, staffLines, fileAttachments);
      await message.react('📨').catch(() => {});

      if (ticketId) {
        try {
          const db = getDb();
          const ticketDoc = await db.collection('tickets').doc(ticketId).get();

          if (ticketDoc.exists) {
            const msgs = ticketDoc.data().messages || [];

            msgs.push({
              authorId: message.author.id,
              authorTag: message.author.tag,
              authorAvatar: message.author.displayAvatarURL({ size: 64 }),
              content: message.content || '',
              attachments: [...message.attachments.values()].map(a => a.url),
              isBot: false,
              from: 'staff',
              timestamp: new Date().toISOString(),
            });

            await db.collection('tickets').doc(ticketId).update({ messages: msgs });
          }
        } catch {}
      }
    } catch {
      await message.reply({
        content: '⚠️ 유저 DM 전송 실패 (DM이 차단되어 있을 수 있습니다)',
      });
    }
  }
});

// ─────────────────────────────────────────────
// 티켓 종료
// ─────────────────────────────────────────────
async function closeTicket(channel, ticketId, member, interaction = null, message = null) {
  if (closingSet.has(ticketId)) return;
  closingSet.add(ticketId);

  try {
    // 1. 채널에 종료 메시지
    const closingEmbed = new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle('🔒 티켓 종료 중')
      .setDescription(`**${member.user.tag}** 님이 티켓을 종료합니다.\n5초 후 채널이 삭제됩니다.`)
      .setTimestamp();
    try {
      if (interaction) await interaction.reply({ embeds: [closingEmbed] });
      else await channel.send({ embeds: [closingEmbed] });
    } catch {}

    // 2. Firestore 업데이트
    const logUrl = `${config.WEB_BASE_URL}ticket/${ticketId}`;
    try {
      await getDb().collection('tickets').doc(ticketId).update({
        status: 'closed',
        closedAt: new Date().toISOString(),
        closedBy: member.user.tag,
        closedById: member.id,
        logUrl,
      });
    } catch (e) { console.error('티켓 종료 저장 실패:', e); }

    // 3. dmMap에서 제거
    const userId = channel.topic?.match(/userId:(\d+)/)?.[1];
    if (userId) dmMap.delete(userId);

    // 4. 고객 DM 전송
    if (userId) {
      try {
        const user = await client.users.fetch(userId);
        await user.send({ embeds: [new EmbedBuilder()
          .setColor(0x7c3aed)
          .setTitle('✅ 문의 종료')
          .setDescription('문의가 종료되었습니다.\n이용해주셔서 감사합니다 🩷')
          .setFooter({ text: 'Turn' })
          .setTimestamp()] });
      } catch (e) { console.error('유저 DM 전송 실패:', e.message); }
    }

    // 5. 로그 채널 전송
    const guild = channel.guild;
    const logChannel = guild.channels.cache.get(config.LOG_CHANNEL_ID);
    if (logChannel) {
      try {
        await logChannel.send({ embeds: [new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle('🔒 티켓 종료 — 로그 저장됨')
          .addFields(
            { name: '📋 채널', value: channel.name, inline: true },
            { name: '👤 닫은 사람', value: member.user.tag, inline: true },
            { name: '🔗 로그 링크', value: logUrl, inline: false },
          )
          .setFooter({ text: 'Turn' })
          .setTimestamp()] });
      } catch {}
    }

    logAction(guild, `🔒 티켓 닫힘`, null, 0xef4444, [
      { name: '채널', value: channel.name, inline: true },
      { name: '닫은 사람', value: member.user.tag, inline: true },
      { name: '로그', value: logUrl, inline: false },
    ]);

    // 6. 5초 후 채널 삭제 + closingSet 정리
    setTimeout(() => {
      channel.delete().catch(() => {}).finally(() => closingSet.delete(ticketId));
    }, 5000);
  } catch (e) {
    console.error('티켓 종료 처리 오류:', e);
    closingSet.delete(ticketId);
  }
}

async function logAction(guild, title, description, color, fields = []) {
  const logChannel = guild.channels.cache.get(config.LOG_CHANNEL_ID);

  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setFooter({ text: 'Turn' })
    .setTimestamp();

  if (description) {
    embed.setDescription(description);
  }

  if (fields.length > 0) {
    embed.addFields(fields);
  }

  logChannel.send({ embeds: [embed] }).catch(() => {});
}

// 처리되지 않은 예외로 봇이 죽지 않게
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});

client.login(config.TOKEN);
