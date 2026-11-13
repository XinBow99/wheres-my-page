/**
 * @fileoverview Constants shared by every execution context: models, vector
 * dimension, embedding prompts, preset categories and storage names.
 *
 * Values that end up in persisted data (dimension, prompts, category ids,
 * database and cache names) must stay identical to v0.5.0.
 */

/** An embedding model the extension can load. */
export interface ModelSpec {
  /** Label shown in the settings model picker. */
  label: string;
  /** Hugging Face URL of the .litertlm model file. */
  url: string;
}

/** Embedding models by settings key. */
export const MODELS = Object.freeze({
  eg2_270m: Object.freeze({
    label: 'EmbeddingGemma-2 Text 270M（推薦）',
    url: 'https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm/resolve/main/embeddinggemma-2-text-270m.litertlm',
  }),
  eg2_440m: Object.freeze({
    label: 'EmbeddingGemma-2 Text-Vision 440M',
    url: 'https://huggingface.co/litert-community/embeddinggemma-2-text-vision-440m-litert-lm/resolve/main/embeddinggemma-2-text-vision-440m.litertlm',
  }),
}) satisfies Readonly<Record<string, Readonly<ModelSpec>>>;

/** Settings key of an embedding model. */
export type ModelKey = keyof typeof MODELS;

/**
 * Model of the image index. Only the text-vision model can embed images, so
 * the image index always uses it, whatever the text model setting is.
 */
export const VISION_MODEL: ModelKey = 'eg2_440m';

/**
 * Stored vector dimension. EmbeddingGemma-2 vectors are Matryoshka, so they
 * are truncated to 256 and renormalized; about 20k chunks then take ~20 MB of
 * memory.
 */
export const DIM = 256;

/** Longest query text, in UTF-16 code units, put into a prompt. */
const QUERY_MAX_LENGTH = 200;

/** Longest page title, in UTF-16 code units, put into a document prompt. */
const TITLE_MAX_LENGTH = 60;

/** Longest category name, in UTF-16 code units, put into a prompt. */
const CATEGORY_NAME_MAX_LENGTH = 40;

/** Longest category description, in UTF-16 code units, put into a prompt. */
const CATEGORY_DESCRIPTION_MAX_LENGTH = 200;

/**
 * EmbeddingGemma task prompts for asymmetric retrieval. Titles and queries
 * are clipped so prompt plus chunk always fit the 512-token input.
 */
export const PROMPT = Object.freeze({
  /**
   * Prompt for a search query.
   *
   * @param q Query text.
   * @return Prompt text.
   */
  query(q: unknown): string {
    return `task: search result | query: ${String(q).slice(0, QUERY_MAX_LENGTH)}`;
  },
  /**
   * Prompt for one chunk of a page.
   *
   * @param title Page title; "none" when empty.
   * @param text Chunk text.
   * @return Prompt text.
   */
  doc(title: unknown, text: string): string {
    const clipped = String(title || 'none').slice(0, TITLE_MAX_LENGTH);
    return `title: ${clipped} | text: ${text}`;
  },
  /**
   * Prompt for a category, which plays the query side when matched against
   * page documents.
   *
   * @param name Category name.
   * @param description Category description; may be empty.
   * @return Prompt text.
   */
  category(name: unknown, description?: unknown): string {
    const head = String(name).slice(0, CATEGORY_NAME_MAX_LENGTH);
    const tail = description
      ? '：' + String(description).slice(0, CATEGORY_DESCRIPTION_MAX_LENGTH)
      : '';
    return `task: search result | query: ${head}${tail}`;
  },
});

/** A built-in category seeded into a new database. */
export interface PresetCategory {
  /** Stable id stored in page tags. */
  id: string;
  /** Display name. */
  name: string;
  /** Chip color. */
  color: string;
  /** Description embedded for auto-tagging; the more specific, the better. */
  description: string;
}

/** Built-in categories (editable and deletable in the search page). */
export const PRESET_CATEGORIES: ReadonlyArray<Readonly<PresetCategory>> =
  Object.freeze(
    [
      {
        id: 'ai',
        name: 'AI／機器學習',
        color: '#7c4dff',
        description:
          '大型語言模型、深度學習、模型訓練與推論、論文、Hugging Face 模型卡、prompt',
      },
      {
        id: 'gpu',
        name: 'GPU／CUDA',
        color: '#2e7d32',
        description:
          'CUDA kernel、GPU 記憶體、TensorRT、vLLM、驅動與編譯問題、推論效能優化',
      },
      {
        id: 'speech',
        name: '語音 ASR／TTS',
        color: '#00838f',
        description:
          '語音辨識、語音合成、字幕、音訊處理、Whisper、Azure Speech',
      },
      {
        id: 'debug',
        name: '除錯／解法',
        color: '#d84315',
        description:
          'GitHub issue、Stack Overflow、錯誤訊息、例外、bug 回報與解決方法',
      },
      {
        id: 'docs',
        name: '文件／教學',
        color: '#1565c0',
        description: '官方文件、API reference、安裝設定、教學文章、範例程式碼',
      },
      {
        id: 'devops',
        name: '部署／雲端',
        color: '#5d4037',
        description: 'Docker、Kubernetes、AWS、Azure、CI/CD、伺服器與網路設定',
      },
      {
        id: 'finance',
        name: '投資理財',
        color: '#c62828',
        description: '台股、美股、ETF、財經新聞、財報、總體經濟',
      },
      {
        id: 'news',
        name: '新聞時事',
        color: '#455a64',
        description: '新聞報導、社會議題、國際局勢、政治',
      },
      {
        id: 'life',
        name: '生活旅遊',
        color: '#ef6c00',
        description: '旅遊攻略、景點、餐廳美食、購物、日常生活',
      },
    ].map(c => Object.freeze(c)),
  );

/** Default denylist: one glob per line, matched by core/policy/denylist. */
export const DEFAULT_DENYLIST = [
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'accounts.google.com',
  'login.microsoftonline.com',
  'web.whatsapp.com',
  'messenger.com',
  'web.telegram.org',
  '*bank*',
  '*.gov.tw/login*',
  'localhost',
  '127.0.0.1',
].join('\n');

/** IndexedDB database of the text index. */
export const TEXT_DB_NAME = 'semhist';

/** IndexedDB database of the image index. */
export const IMAGE_DB_NAME = 'semhist-img';

/** Cache Storage cache holding downloaded model files. */
export const MODEL_CACHE_NAME = 'semhist-models-v1';
