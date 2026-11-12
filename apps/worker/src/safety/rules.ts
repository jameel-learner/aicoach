/**
 * Safety rules (architecture §6.2, decision 9.6-5): the first, deterministic check on every
 * free-text turn of a learner. No network call, so it always runs and always gives the same result.
 *
 *  - `distress`  → the fixed handoff response and a parent alert. Never an LLM reply.
 *  - `overwhelm` → the "make today smaller" offer (spec 5.5.7). Never a pep talk.
 *
 * Subject wording must not trip it: Accountancy has "death of a partner", "deceased partner",
 * "dead stock" and "dissolution". The rules below need first-person wording about the learner.
 *
 * NEEDS REVIEW before the pilot: a counsellor for the wording covered, and native speakers for the
 * romanised Hindi and Kannada phrases. The red-team set is test/fixtures/safety-redteam.ts.
 */

export type SafetyLevel = 'ok' | 'overwhelm' | 'distress';
export interface SafetyVerdict {
  level: SafetyLevel;
  /** Which rule matched (stored instead of the learner's words). */
  rule: string | null;
}

const ME = "(?:i|i'?m|im|i am|i'?ve|i have|i'?ll|i will|me|my|myself)";

const DISTRESS: [string, RegExp][] = [
  [
    'self_harm',
    /\b(?:kill(?:ing)? my ?self|end(?:ing)? my (?:own )?life|tak(?:e|ing) my (?:own )?life|suicid\w*|(?:(?:want|wanted|wish|like) to|wanna) die|wish i (?:was|were) dead|wish i (?:was|were) never born|better off dead|do(?:n'?t| not) (?:want|wanna) to (?:live|be alive|exist|wake up)|no (?:reason|point) (?:to|in) (?:live|living|go(?:ing)? on)|(?:hurt|harm|cut|cutting|hurting|harming) my ?self|self[- ]?harm\w*|end it all|not worth living|can'?t go on (?:living|like this)|(?:disappear|sleep) (?:forever|and never wake(?: up)?)|jump (?:off|from) (?:a |the |my |our )?(?:building|bridge|terrace|roof|balcony|\w+ floor)|jump in front of|hang my ?self|poison my ?self|overdos(?:e|ing) (?:on|myself)|end(?:ing)? (?:things|everything|it) (?:for good|forever|once and for all|tonight|today)|ending (?:things|it all)|no way out|(?:happier|better off) (?:if i (?:was|were) gone|without me|if i was ?n'?t (?:here|around))|if i (?:was|were) gone|wo(?:n'?t| not) be (?:here|around) (?:any ?more|tomorrow|much longer|for long)|do(?:n'?t| not) (?:want|wanna) to be here any ?more|nothing matters (?:any ?more|to me))\b/,
  ],
  [
    'hopeless',
    new RegExp(
      `\\b(?:${ME} (?:am |feel |feeling )?(?:so |totally |completely |just )?(?:worthless|a (?:total |complete )?(?:failure|burden|waste)|hopeless(?! (?:at|in|with))|depressed|empty inside|numb inside)|(?:nobody|no ?one) (?:cares|would (?:care|miss me|notice))|every(?:one|body) (?:hates me|would be better off without me)|i hate (?:myself|my life)|my life is (?:over|ruined|pointless|meaningless|a waste)|i can'?t (?:take|bear) (?:it|this|life) any ?more|i give up on (?:life|everything)|what'?s the point of (?:living|my life|anything)|i (?:cry|am crying|keep crying) (?:every|all) (?:day|night))\\b`,
    ),
  ],
  [
    // Someone is hurting the learner. The alert for this rule never goes to the parent (handoff.ts).
    'harm_by_others',
    /\b(?:(?:my |our )?(?:father|mother|dad|daddy|mom|mum|mummy|papa|amma|appa|parents?|uncle|aunt|brother|teacher|sir|madam|lecturer|seniors?|they|he|she) (?:beats?|hits?|slaps?|abuses?|touche[sd]|molest\w*|threaten\w*|locks?|locked|tortures?) me|i(?:'?m| am) (?:being )?(?:bullied|abused|beaten|ragged|harassed|molested|blackmailed|threatened)|(?:scared|afraid) to go home|touch(?:es|ed|ing) me (?:in|where))\b/,
  ],
  [
    'acute',
    /\b(?:panic attacks?|can'?t breathe|ha(?:ve|d)n'?t (?:slept|eaten) (?:in|for) (?:days|\d+ days)|run(?:ning)? away from home|leav(?:e|ing) home forever)\b/,
  ],
  [
    // Romanised Hindi, as typed in chat ("mar jaunga", "jeena nahi chahta", "khudkushi").
    'self_harm_hi',
    /\b(?:mar ?ja(?:u|oo|un|oon)n?g[ai]|mar jana chaht[ai]|marna chaht[aie]|marne ka (?:man|mann|dil)|jeena nahi(?:n)?(?: chaht[ai])?|jeene ka (?:man|mann) nahi(?:n)?|zindagi (?:se thak|khatam|bekaar)|khud ?kushi|a{1,2}tma ?hat[iy]a|jaan de (?:du|doo|dun|doon)n?g[ai]|suicide kar|apni jaan le|mujhe mar jana)\b/,
  ],
  [
    // Romanised Kannada ("saayabeku" = I should die, "badukodu beda" = don't want to live).
    'self_harm_kn',
    /\b(?:saa?ya?beku|saa?ythi?ni|sattu ?hog(?:thi|ti|bi)\w*|saa?yona|badukod[ua] beda|baduku beda|baalod[ua] beda|jeevana saaku|jeevana beda|aa?thma ?hathye|aa?tma ?hatye|nanage saavu)\b/,
  ],
];

const FEEL = "(?:i(?:'?m| am)|i feel|i(?:'?m| am) feeling|feeling)";
const OVERWHELM: [string, RegExp][] = [
  [
    'overwhelm',
    new RegExp(
      `\\b(?:(?:this|that|it|it'?s|its|everything|syllabus|portion) (?:is |are )?(?:all |just |way )?too much|too much (?:for me|to (?:study|learn|remember|handle|take|cover)|today|right now|stress|pressure|tension|portion|syllabus)|overwhelm\\w*|${FEEL} (?:so |too |very |really |totally )?(?:stressed|tensed|anxious|worried|tired(?! of)|drained|exhausted|burn(?:t|ed) out|scared|lost)|stressed out|can'?t (?:cope|focus|concentrate|keep up|do this|do it|manage|handle (?:it|this)|understand anything)(?: any ?more)?|(?:i(?:'?m| am)|am i) (?:going to|gonna) fail|i(?:'?ll| will) (?:surely |definitely )?fail|scared of (?:the |my )?(?:exams?|boards?|results?)|exam (?:fear|tension|stress|pressure|anxiety)|i give up|give up for today|no energy|nothing (?:is )?going (?:in|into my head)|my (?:head|brain) (?:hurts|is (?:full|fried|blank))|(?:parents?|father|mother|dad|mom|papa|amma|appa) will kill me|bahut (?:zyada|tension|mushkil)|tension ho (?:rahi|raha)|nahi(?:n)? ho (?:raha|payega|paa raha)|thak (?:gay[ai]|gayi)|dimag (?:kharab|nahi chal)|aagalla|aagtilla|thumba (?:kashta|tension)|tension aag\\w*|saak(?:u|aythu|aaythu))\\b`,
    ),
  ],
];

/** Lowercase, straighten quotes, collapse stretched letters ("sooo") and spacing. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/(\p{L})\1{2,}/gu, '$1')
    .replace(/[^\p{L}\p{N}' -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function checkRules(text: string): SafetyVerdict {
  const t = normalise(text);
  if (!t) return { level: 'ok', rule: null };
  for (const [rule, re] of DISTRESS) if (re.test(t)) return { level: 'distress', rule };
  for (const [rule, re] of OVERWHELM) if (re.test(t)) return { level: 'overwhelm', rule };
  return { level: 'ok', rule: null };
}
