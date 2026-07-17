/**
 * Customer-discovery survey — shared question definitions.
 * Used by the public survey page, the admin results page, and the AI analysis prompt
 * so question ids/labels stay consistent everywhere.
 */

export type SurveyQuestion = {
  id: string;
  /** Full question text shown to the respondent */
  label: string;
  /** Short label used in results tables and the analysis prompt */
  short: string;
  kind: "text" | "textarea" | "choice";
  optional?: boolean;
  choices?: string[];
  placeholder?: string;
  hint?: string;
  /** 0 = respondent info, 1 = Part 1, 2 = Part 2 */
  part: 0 | 1 | 2;
};

export const SURVEY_QUESTIONS: SurveyQuestion[] = [
  {
    id: "q0",
    label: "Your name, role, and organization",
    short: "Name / role / organization",
    kind: "text",
    placeholder: "e.g., Development Program Lead at top 10 pharma",
    hint: "Feel free to be generic if more comfortable — such as “Development Program Lead at top 10 pharma”.",
    part: 0,
  },
  {
    id: "q1",
    label:
      "Think of a real strategic R&D or portfolio decision in the last year or so where the options had genuinely different value implications — an indication choice, a trial design, a go/no-go, a partnering call, whatever comes to mind. What was the decision?",
    short: "What was the decision?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q2",
    label: "How did the team actually get to an answer — what analysis, tools, or people did you lean on?",
    short: "How did the team get to an answer?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q3",
    label: "What was hardest, slowest, or most debated in getting to a decision?",
    short: "Hardest / slowest / most debated",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q4",
    label:
      "When someone challenged the assumptions — leadership, a committee, a partner — how well did the analysis hold up? Could you re-run it fast, or was it fragile?",
    short: "How did the analysis hold up when challenged?",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q5",
    label: "Were there analyses the team wanted but did not have time, data, or confidence to produce?",
    short: "Analyses wanted but not produced",
    kind: "textarea",
    part: 1,
  },
  {
    id: "q6",
    label: "Is this kind of decision a one-off, or does your team face some version of it regularly?",
    short: "One-off or regular?",
    kind: "choice",
    choices: ["Mostly a one-off", "Comes up occasionally", "We face some version of it regularly"],
    part: 1,
  },
  {
    id: "q6detail",
    label: "Anything to add — how often, in what form?",
    short: "Frequency detail",
    kind: "textarea",
    optional: true,
    placeholder: "Anything to add — how often, in what form?",
    part: 1,
  },
  {
    id: "q7",
    label:
      "For the specific decision you just walked me through — would you have actually used something like this in that process? If yes, where exactly would it have plugged in? And what would have made you not bother?",
    short: "Would you have used this? Where / why not?",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q8",
    label:
      "If yes — what would a tool like this have to prove before you'd trust its number in a real decision that leadership sees? What about using it systematically as part of your R&D portfolio decision-making?",
    short: "What would it have to prove to be trusted?",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q9",
    label:
      "If yes — how likely is it that your internal organization would build and provide a sufficient tool itself, rather than outsourcing?",
    short: "Build internally vs. outsource",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q10",
    label:
      "If you'd outsource — what price range pops into your mind that would make you immediately push for approval?",
    short: "Price range for immediate approval",
    kind: "textarea",
    part: 2,
  },
  {
    id: "q11",
    label:
      "Who else in the organization feels this pain most directly — portfolio strategy, finance, BD, commercial, clinical development, someone else? Is there someone you think I should speak with to understand this workflow better?",
    short: "Who else feels this pain / referrals",
    kind: "textarea",
    optional: true,
    part: 2,
  },
];

export const SURVEY_QUESTION_IDS = SURVEY_QUESTIONS.map((q) => q.id);

/** Questions counted toward the respondent progress bar (q0 and q6detail are optional extras). */
export const PROGRESS_IDS = SURVEY_QUESTIONS.filter((q) => !q.optional).map((q) => q.id);

export const CONCEPT_TEXT = [
  "It's an AI platform that builds a defensible, sourced valuation for an asset — from preclinical to LCM — with industry-leading AI-driven probability calculations, and lets you compare the value of strategic options: indication sequencing, trial design, partnering, go/no-go — with the reasoning shown and traceable, not a black box.",
  "You could add and compare new options, or changes to options, instantly and as often as you like, simply by asking in plain language.",
];
