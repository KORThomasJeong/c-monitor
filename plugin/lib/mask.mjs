// 서버로 보내기 전에 비밀(API 키·토큰·비밀번호)을 가린다.
export const MASK = '••••••••';

// 한 번의 훑기로 처리해서 같은 자리를 두 번 세지 않는다. 앞에 있는 갈래가 우선한다.
const PATTERN = new RegExp(
  [
    // 개인 키 블록(여러 줄)
    '(?<pem>-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----)',
    // password=값 류. 키 이름과 = 는 남기고 값만 가린다. (DB_PASSWORD= 처럼 접두어가 붙어도 된다)
    '(?<kvKey>(?<![A-Za-z0-9])(?:password|passwd|secret|token|api_key|apikey)=)(?<kvVal>"[^"\\r\\n]*"|\'[^\'\\r\\n]*\'|[^\\s&"\',;]+)',
    // Bearer 토큰
    '(?<bearer>\\bBearer\\s+)[A-Za-z0-9._~+/=-]{8,}',
    // JWT 모양
    '(?<jwt>\\beyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,})',
    // sk-ant-… 와 sk-…(20자 이상). 짧은 sk- 단어는 그대로 둔다.
    '(?<sk>\\bsk-[A-Za-z0-9_-]{20,})',
    // GitHub 토큰
    '(?<gh>\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}))',
    // AWS 액세스 키
    '(?<aws>\\bAKIA[0-9A-Z]{16}\\b)',
    // Slack 토큰
    '(?<slack>\\bxox[bp]-[A-Za-z0-9-]{10,})',
    // Google API 키
    '(?<google>\\bAIza[0-9A-Za-z_-]{35})',
    // Google OAuth 클라이언트 보안 비밀
    '(?<goauth>\\bGOCSPX-[A-Za-z0-9_-]{20,})',
    // Google OAuth 액세스 토큰
    '(?<gtoken>\\bya29\\.[A-Za-z0-9._-]{20,})',
  ].join('|'),
  'gi',
);

// 대소문자를 가려야 하는 갈래(일반 단어와 헷갈리지 않게)
const CASE_SENSITIVE = {
  jwt: /^eyJ/, sk: /^sk-/, gh: /^(gh[pousr]_|github_pat_)/, aws: /^AKIA[0-9A-Z]{16}$/, slack: /^xox[bp]-/, google: /^AIza/,
  goauth: /^GOCSPX-/, gtoken: /^ya29\./,
};

/** 글 안의 비밀을 가린다. → {text, count(가린 개수)} */
export function maskSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return { text: typeof text === 'string' ? text : '', count: 0 };
  let count = 0;
  const out = text.replace(PATTERN, (match, ...rest) => {
    const groups = rest[rest.length - 1];
    if (groups.kvKey !== undefined) {
      if (groups.kvVal === MASK) return match;
      count += 1;
      return groups.kvKey + MASK;
    }
    if (groups.bearer !== undefined) {
      count += 1;
      return groups.bearer + MASK;
    }
    for (const [name, check] of Object.entries(CASE_SENSITIVE)) {
      if (groups[name] !== undefined && !check.test(match)) return match;
    }
    count += 1;
    return MASK;
  });
  return { text: out, count };
}

const SECRET_KEY = /^(password|passwd|secret|token|api[_-]?key)$/i;

/** 객체·배열 안의 모든 문자열을 가린다(원본은 바꾸지 않는다). → {value, count} */
export function maskDeep(value) {
  let count = 0;
  const walk = (v, key, depth) => {
    if (typeof v === 'string') {
      // 이름부터 비밀번호류인 키는 값의 모양과 상관없이 가린다.
      if (key !== undefined && SECRET_KEY.test(key) && v.length > 0) {
        count += 1;
        return MASK;
      }
      const r = maskSecrets(v);
      count += r.count;
      return r.text;
    }
    if (v === null || typeof v !== 'object') return v;
    if (depth > 40) return null; // 지나치게 깊은 구조는 버린다
    if (Array.isArray(v)) return v.map((item) => walk(item, undefined, depth + 1));
    const out = {};
    for (const [k, item] of Object.entries(v)) out[k] = walk(item, k, depth + 1);
    return out;
  };
  return { value: walk(value, undefined, 0), count };
}
