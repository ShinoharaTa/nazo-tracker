// 部品見本（GET /_ui）用の仮データ。参照モックの works / records をそのまま移したもの。

import type { AttemptStatus, WorkKind } from './labels'

export type GalleryWork = {
  id: string
  title: string
  org: string
  kind: WorkKind
  area: string
  venue: string
  period: string
  players: string
  time: string
  played: number
  wish: number
  friends: number
  channels?: { name: string; note: string }[]
}

export type GallerySession = { date: string; time: string; progress: string; memo: string }

export type GalleryRecord = {
  id: string
  work: string
  status: AttemptStatus
  date: string
  companions: string
  party: number
  diff: number
  vol: number
  rating: number
  genres: string[]
  memo: string
  spoiler: string
  photos: { k: string; sp?: boolean }[]
  sessions: GallerySession[]
}

export const works: GalleryWork[] = [
  {
    id: 'w1',
    title: '時計塔の消えた鐘',
    org: 'からくり堂',
    kind: 'hall',
    area: '東京都',
    venue: 'からくり堂ホール新宿',
    period: '2026-09-01〜2026-12-27',
    players: '1〜6人',
    time: '約120分',
    played: 128,
    wish: 42,
    friends: 2,
  },
  {
    id: 'w2',
    title: '星降る街の周遊録',
    org: 'ナゾラボ',
    kind: 'stroll',
    area: '神奈川県',
    venue: 'みなとみらい周辺（キット受取: 駅前案内所）',
    period: '2026-07-01〜2027-03-31',
    players: '1〜4人',
    time: '目安 4〜6時間',
    played: 3,
    wish: 17,
    friends: 0,
  },
  {
    id: 'w3',
    title: '封蝋の書簡',
    org: 'Puzzle Atelier',
    kind: 'takeaway',
    area: '通販',
    venue: '',
    period: '2026-05-10 発売',
    players: '1人〜',
    time: '目安 3時間',
    played: 56,
    wish: 9,
    friends: 1,
    channels: [
      { name: '公式オンラインストア', note: '販売中' },
      { name: 'ゲームマーケット2026秋', note: 'ブース B-12 · 2026-11-14〜15' },
      { name: 'ナゾトキマーケット vol.8', note: '2026-06-21 · 終了' },
    ],
  },
  {
    id: 'w4',
    title: '深海研究所からの脱出',
    org: 'からくり堂',
    kind: 'room',
    area: '東京都',
    venue: 'からくり堂 渋谷店（常設）',
    period: '常設',
    players: '2〜5人',
    time: '60分',
    played: 311,
    wish: 24,
    friends: 0,
  },
  {
    id: 'w5',
    title: '夜行列車の手紙',
    org: 'ナゾラボ',
    kind: 'line',
    area: 'オンライン',
    venue: '',
    period: '2026-10-01〜',
    players: '1人',
    time: '目安 90分',
    played: 0,
    wish: 4,
    friends: 0,
  },
  {
    id: 'w6',
    title: '地下書庫の司書',
    org: 'ナゾラボ',
    kind: 'room',
    area: '東京都',
    venue: 'ナゾラボ 池袋ルーム（常設）',
    period: '常設',
    players: '2〜4人',
    time: '60分',
    played: 48,
    wish: 31,
    friends: 1,
  },
  {
    id: 'w7',
    title: '鏡の国の採点表',
    org: 'Puzzle Atelier',
    kind: 'web',
    area: 'オンライン',
    venue: '',
    period: '2026-03-01〜',
    players: '1人',
    time: '目安 60分',
    played: 19,
    wish: 2,
    friends: 0,
  },
  {
    id: 'w8',
    title: '灯台守の最後の夜',
    org: 'からくり堂',
    kind: 'hall',
    area: '大阪府',
    venue: 'からくり堂ホール梅田',
    period: '2026-04-01〜2026-06-30',
    players: '1〜6人',
    time: '約120分',
    played: 7,
    wish: 6,
    friends: 0,
  },
]

export const records: GalleryRecord[] = [
  {
    id: 'r1',
    work: 'w1',
    status: 'cleared',
    date: '2026-10-12',
    companions: 'みお、けい',
    party: 3,
    diff: 4,
    vol: 3,
    rating: 5,
    genres: ['ひらめき', 'ストーリー', '体験・演出'],
    memo: '後半の演出がすごく良かった。3人だと少し忙しいので4人推奨。',
    spoiler: '最後の鐘の数は時計の針ではなく、壁の影の本数。',
    photos: [{ k: 'キービジュアル' }, { k: 'クリアパネル', sp: true }],
    sessions: [],
  },
  {
    id: 'r2',
    work: 'w2',
    status: 'in_progress',
    date: '',
    companions: 'みお',
    party: 2,
    diff: 3,
    vol: 4,
    rating: 0,
    genres: ['探索', '物量', 'ストーリー'],
    memo: '',
    spoiler: '第3章の暗号はキットの裏表紙と組み合わせる。',
    photos: [{ k: 'キービジュアル' }],
    sessions: [
      {
        date: '2026-10-11',
        time: '2h30m',
        progress: '第3章まで',
        memo: '港エリアのチェックポイント4つ。雨で一時中断。',
      },
      {
        date: '2026-10-04',
        time: '1h40m',
        progress: '第1〜2章',
        memo: 'キット受け取り。駅前から開始。',
      },
    ],
  },
  {
    id: 'r3',
    work: 'w4',
    status: 'failed',
    date: '2026-09-21',
    companions: 'けい、そう',
    party: 3,
    diff: 5,
    vol: 4,
    rating: 4,
    genres: ['論理', '物量'],
    memo: '残り3分で時間切れ。再挑戦したい。',
    spoiler: '',
    photos: [],
    sessions: [],
  },
  {
    id: 'r4',
    work: 'w3',
    status: 'purchased',
    date: '2026-09-15',
    companions: '',
    party: 0,
    diff: 0,
    vol: 0,
    rating: 0,
    genres: [],
    memo: '',
    spoiler: '',
    photos: [],
    sessions: [],
  },
  {
    id: 'r5',
    work: 'w7',
    status: 'cleared',
    date: '2026-08-02',
    companions: '',
    party: 1,
    diff: 2,
    vol: 2,
    rating: 3,
    genres: ['ひらめき'],
    memo: '',
    spoiler: '',
    photos: [],
    sessions: [],
  },
  {
    id: 'r6',
    work: 'w6',
    status: 'cleared',
    date: '2026-06-14',
    companions: 'けい',
    party: 2,
    diff: 3,
    vol: 3,
    rating: 4,
    genres: ['探索', '協力'],
    memo: '',
    spoiler: '',
    photos: [],
    sessions: [],
  },
  {
    id: 'r7',
    work: 'w8',
    status: 'failed',
    date: '2026-05-03',
    companions: 'みお、けい、そう',
    party: 4,
    diff: 4,
    vol: 5,
    rating: 3,
    genres: ['論理', '物量'],
    memo: '',
    spoiler: '',
    photos: [],
    sessions: [],
  },
]
