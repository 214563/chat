/**
 * cloud-sync-engine.js — 阶段二：文字数据实时同步引擎
 *
 * 依赖：CloudSync（阶段一）、localforage、APP_PREFIX
 *
 * 职责：
 *   1. 收集本地所有"文字类"数据，打包成一个 JSON
 *   2. 通过阿里云 OSS V4 签名上传到 Bucket 的 sync/text-data.json
 *   3. 触发时机：本地写入后 3 秒防抖 / 页面隐藏 / 启动检测
 *   4. 静默恢复：启动时若本地空但云端有数据，弹窗询问是否恢复
 *   5. 状态：exposed via CloudSync.getSyncStatus()，UI 主动读取
 *
 * 完全后台运行，不弹 Toast、不闪图标、不打断用户。
 * 唯一会打扰用户的是：连续失败 → 数据管理面板显示不显眼红点。
 */
(function (global) {
    'use strict';

    // ==== 常量 ====
    var APP_PREFIX_STR = (typeof APP_PREFIX !== 'undefined' ? APP_PREFIX : 'CHAT_APP_V3_');

    // 云端对象命名
    function _syncObjectKey() {
        var sid = (typeof SESSION_ID !== 'undefined' && SESSION_ID) ? SESSION_ID : 'default';
        return 'sync/' + sid + '/text-data.json';
    }
    // 云端所有梦角的索引文件
    function _indexObjectKey() {
        return 'sync/index.json';
    }

    // 从 payload 中提取梦角名字（partnerName）用于展示
    function _extractPartnerName(payload) {
        try {
            if (!payload || !payload.indexedDB) return null;
            for (var k in payload.indexedDB) {
                if (k.indexOf('chatSettings') !== -1) {
                    var s = payload.indexedDB[k];
                    if (s && typeof s === 'object' && s.partnerName) return s.partnerName;
                }
            }
        } catch (e) {}
        return null;
    }

    // ==== 键名分类 ====

    // 1) 带 SESSION_ID 前缀的文字类键（媒体类不在此列，留阶段三）
    var SESSION_TEXT_NEEDLES = [
        // 聊天
        'chatMessages', 'chatSettings', 'showPartnerNameInChat',
        'envelopeData', 'pending_envelope',
        // 回复 / 氛围
        'customReplies', 'customPokes', 'customStatuses', 'customMottos',
        'customIntros', 'customEmojis', 'customPeriodCare',
        'customReplyGroups', 'customPokeGroups', 'customStatusGroups',
        // 经期记录（日历标记、每日打卡、梦角留言状态）
        'periodData',
        // 调查问卷（我问梦角/梦角问我，图片选项是 oss:// 引用或未配置OSS时的本地 base64，体积小）
        'surveyData',
        // 红包（发送/接收记录、留言库、调度器状态——金额和祝福语都是纯文字，
        // 之前这个键完全没在同步清单里，红包这块的文字数据一直没被云端同步覆盖到）
        'redpacketData',
        // 纪念日
        'anniversaries', 'annCoverBg_', 'annMeetOverride', 'annPinnedId',
        // 相册（相册列表/照片归属/收藏/回收站，图片本身是 oss:// 引用，体积小）
        'albumData',
        // 动态（贴文/评论/点赞，图片有清洗逻辑见下方 _collectTextData）
        'momentsData',
        // 电影院（约定/待看清单/观看历史/协商/梦角主动邀请，全是文字数字，没有图片）
        '_cinemaAppt', '_cinemaWatchlist', '_cinemaHistory', '_cinemaNego', '_cinemaPartnerInvite',
        // 情侣空间设置（等待延迟/是否保存对方图片，纯文字数字）
        'csSpaceSettings',
        // 情侣空间壁纸（当前壁纸 + 壁纸库，图片有清洗逻辑见下方 _collectTextData）
        'csWallpaper', 'csWallpaperGallery',
        // 心情手账（不含图片）
        'moodCalendar', 'customMoodOptions', 'moodTrash',
        // 主题人设
        'partnerPersonas',
        // 贴纸库（文字索引，实际图片阶段三B处理）
        'stickerLibrary', 'myStickerLibrary', 'myStickerGroups',
        // 陪伴日记文字
        'companionData', 'companionDiary',
        // 信件
        'partnerLetterNextTime',
        // 阶段三A：背景图库（现在存的是 oss:// 引用 + 缩略图，可以同步）
        'backgroundGallery', 'chatBackground',
        // 阶段三B：日记背景（同上，云端引用后可同步；有 payload 保护过滤 base64）
        'companionDiaryBg', 'companionDiaryBgGallery',
        // 阶段四：收藏语音（值是 oss:// 引用，体积小可以同步；有 sanitize 过滤 base64）
        'favAudio_',
        // 头像（配置了云端、迁移过的话是 oss:// 引用，体积小可以同步；有 sanitize 过滤本地 base64，
        // 没迁移过的老数据不会硬塞大 base64 进同步包，换设备后跑一下"迁移到云端"补上就行）
        'partnerAvatar', 'myAvatar'
    ];

    // 媒体类键（大 base64，不走文字同步 payload）
    var SESSION_MEDIA_NEEDLES = [
    ];

    // 2) 全局键（无 SESSION_ID 前缀）- 文字类，需要同步
    var GLOBAL_TEXT_KEYS = [
        APP_PREFIX_STR + 'sessionList',    // 梦角列表（最重要！）
        APP_PREFIX_STR + 'customThemes',   // 主题
        APP_PREFIX_STR + 'themeSchemes',   // 主题方案
        APP_PREFIX_STR + 'customSongs',    // 悬浮播放器歌单（不分账号，全局共享）
        APP_PREFIX_STR + 'callBgImageData' // 通话背景图（不分账号，全局共享；有 sanitize 过滤本地 base64）
    ];

    // 不同步的全局键（系统状态，不属于用户数据）
    var GLOBAL_SKIP_KEYS = [
        APP_PREFIX_STR + 'cloudSyncConfig',
        APP_PREFIX_STR + 'tour_seen',
        APP_PREFIX_STR + 'MIGRATION_V2_DONE',
        APP_PREFIX_STR + 'lastSessionId'
    ];

    // 3) localStorage 中的文字类键
    var TEXT_LS_KEYS = [
        'groupChatSettings',
        'disabledReplyItems', 'pokeSym_my', 'pokeSym_partner',
        'pokeSym_my_custom', 'pokeSym_partner_custom',
        'disabledStickerItems',
        'dg_custom_data', 'dg_status_pool', 'weekly_fortune', 'daily_fortune',
        'voiceTtsConfig'
    ];
    var TEXT_LS_PREFIXES = ['customWeather_'];

    // 同步状态（内存）
    var _state = {
        lastSyncAt: null,          // Date | null
        lastSyncOk: null,          // true | false | null
        lastError: null,           // string | null
        consecutiveFailures: 0,
        syncing: false,
        pendingTimer: null,
        pendingReason: null,       // 'change' | 'visibility' | 'manual'
        restoreOffered: false,     // 本次会话是否已经询问过恢复
        listeners: [],
        // ready 标记：只有 SESSION_ID 就绪 + 启动检测完成后才允许触发同步。
        // 避免 app 启动加载数据时被误认为"数据变化"，把 pending 表覆盖到云端。
        ready: false,
        // 本次会话是否已经弹过失败告警 toast（避免连续刷屏）
        failAlertShown: false,
        // 是否有恢复流程正在进行（暂停所有同步）
        restoreInProgress: false,
        // 是否有梦角选择器正在等待用户操作（本地是空的，未选择前不允许同步覆盖云端）
        awaitingRestoreChoice: false,
        // 本次收集时因体积过大被跳过的内联媒体数量（base64 图片/语音）
        skippedMedia: 0,
        // 是否已经提示过"图片被跳过，建议迁移"
        mediaHintShown: false
    };

    // 防抖延迟（数据变化后）
    var DEBOUNCE_MS = 3000;
    // 静默失败告警阈值（连续失败几次才提示）
    var FAIL_ALERT_THRESHOLD = 3;

    // ==== 状态通知 ====
    function _notify() {
        for (var i = 0; i < _state.listeners.length; i++) {
            try {
                _state.listeners[i]({
                    lastSyncAt: _state.lastSyncAt,
                    lastSyncOk: _state.lastSyncOk,
                    lastError: _state.lastError,
                    consecutiveFailures: _state.consecutiveFailures,
                    syncing: _state.syncing,
                    hasFailAlert: _state.consecutiveFailures >= FAIL_ALERT_THRESHOLD
                });
            } catch (e) {}
        }
    }

    function onSyncStatusChange(fn) {
        if (typeof fn === 'function') _state.listeners.push(fn);
    }

    function getSyncStatus() {
        return {
            lastSyncAt: _state.lastSyncAt,
            lastSyncOk: _state.lastSyncOk,
            lastError: _state.lastError,
            consecutiveFailures: _state.consecutiveFailures,
            syncing: _state.syncing,
            hasFailAlert: _state.consecutiveFailures >= FAIL_ALERT_THRESHOLD
        };
    }

    // ==== 判断某个 localforage key 是否需要同步 ====
    function _isTextKey(key) {
        if (key.indexOf(APP_PREFIX_STR) !== 0) return false;

        // 全局文字键（直接匹配）
        if (GLOBAL_TEXT_KEYS.indexOf(key) !== -1) return true;

        // 跳过的全局键（密钥、系统状态）
        if (GLOBAL_SKIP_KEYS.indexOf(key) !== -1) return false;

        // 跳过媒体类键（带 SESSION_ID 前缀，阶段三处理）
        for (var m = 0; m < SESSION_MEDIA_NEEDLES.length; m++) {
            if (k