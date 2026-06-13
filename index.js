const {
  Client,
  GatewayIntentBits,
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
  partials: ['CHANNEL', 'MESSAGE'],
});

initFirebase();

let ticketCounter = 0;
const dmMap = new Map();
const closingSet = new Set(); // 중복 종료 방지

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
});

client.on('interactionCreate', async (interaction) => {

  // ── /panel ──
  if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ 관리자만 사용 가능합니다.', ephemeral: true });
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
        ephemeral: true,
      });
    }

    await targetChannel.send({ embeds: [embed], components: [row] });
    return interaction.reply({
      content: `✅ ${targetChannel} 에 패널 전송 완료!`,
      ephemeral: true,
    });
  }

  // ── /설정 ──
  if (interaction.isChatInputCommand() && interaction.commandName === '설정') {
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ 관리자만 사용 가능합니다.', ephemeral: true });
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
      ephemeral: true,
    });
  }

  // ── /설정확인 ──
  if (interaction.isChatInputCommand() && interaction.commandName === '설정확인') {
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ 관리자만 사용 가능합니다.', ephemeral: true });
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
      ephemeral: true,
    });
  }

  // ── 티켓 버튼 ──
  if (interaction.isButton() && interaction.customId.startsWith('ticket_btn:')) {
    await interaction.deferReply({ flags: 64 });

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

      return interaction.editReply({
        content: `❌ 이미 진행중인 문의가 있습니다.${existingCh ? ` (${existingCh})` : ''}`,
      });
    }

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

    const channelName = `${option.value.toLowerCase()}-${safeName}`;
    const ticketNum = String(ticketCounter).padStart(4, '0');

    const ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: `ticketId:${ticketId} | userId:${member.id} | type:${option.value}`,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: config.STAFF_ROLE_ID,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.ManageMessages,
          ],
        },
        {
          id: config.STAFF_ROLE_ID2,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.ManageMessages,
          ],
        },
        {
          id: config.STAFF_ROLE_ID3,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.ManageMessages,
          ],
        },
        {
          id: client.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
      ],
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
      .where('status', '==', 'closed')
      .orderBy('closedAt', 'desc')
      .limit(4)
      .get();

    if (!snap.empty) {
      recentList = snap.docs.map(doc => {
        const d = doc.data();
        const date = new Date(d.closedAt);
        const label =
          `${String(date.getFullYear()).slice(2)}년 ` +
          `${String(date.getMonth() + 1).padStart(2, '0')}월 ` +
          `${String(date.getDate()).padStart(2, '0')}일 문의내역`;

        return `[${label}](${config.WEB_BASE_URL}ticket/${d.ticketId})`;
      }).join('\n');
    }
  } catch {}

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
      `<@&${config.STAFF_ROLE_ID}> 새 문의가 접수되었습니다.\n\n` +
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
    if (!ticketChannel) return;

    const relayEmbed = new EmbedBuilder()
      .setColor(0x6366f1)
      .setAuthor({
        name: `${message.author.tag} (유저)`,
        iconURL: message.author.displayAvatarURL({ size: 64 }),
      })
      .setDescription(message.content || '(첨부파일)')
      .setTimestamp();

    const files = message.attachments.map(a => a.url);

    await ticketChannel.send({ embeds: [relayEmbed], files });
    await message.react('✅').catch(() => {});

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

    const isStaff = (
      message.member?.roles.cache.has(config.STAFF_ROLE_ID) ||
      message.member?.roles.cache.has(config.STAFF_ROLE_ID2) ||
      message.member?.roles.cache.has(config.STAFF_ROLE_ID3)
    );

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

    // ! 내부 메시지
    if (content.startsWith('!')) {
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

    // 일반 스탭 답변
    if (!userId) return;

    try {
      const user = await client.users.fetch(userId);
      const fileAttachments = message.attachments.map(
        a => new AttachmentBuilder(a.url, { name: a.name })
      );

      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xa78bfa)
            .setAuthor({
              name: 'Turn 고객센터',
              iconURL: client.user.displayAvatarURL(),
            })
            .setDescription(message.content || '(첨부파일)')
            .setFooter({ text: 'Turn • 이 메시지에 답장하면 스탭에게 전달됩니다' })
            .setTimestamp(),
        ],
        files: fileAttachments.length > 0 ? fileAttachments : [],
      });

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
              attachments: message.attachments.map(a => a.url),
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

  // 6. 5초 후 채널 삭제
  setTimeout(() => channel.delete().catch(() => {}), 5000);
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

client.login(config.TOKEN);
