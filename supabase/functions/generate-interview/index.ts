import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CLAUDE_MODEL = "claude-opus-4-7";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function callClaude(
  apiKey: string,
  messages: { role: string; content: string }[],
  system: string,
  maxTokens = 4096,
): Promise<string> {
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any)?.error?.message ?? `Anthropic API error ${res.status}`);
  }

  const data = await res.json();
  return (data as any).content[0].text as string;
}

function parseJSON(text: string): unknown {
  const clean = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  return JSON.parse(clean);
}

async function generateQuestions(
  apiKey: string,
  params: { jobContent: string; questionType: string; numQuestions: number; resumeContent?: string },
) {
  const typeMap: Record<string, string> = {
    behavioral: "behavioral (STAR-format) questions only",
    technical: "technical/role-specific questions only",
    mix: "a mix of behavioral (STAR-format) and technical/role-specific questions",
  };

  const resumeSection = params.resumeContent?.trim()
    ? `\n\nCandidate's Resume/Background:\n${params.resumeContent.slice(0, 3000)}\n\nIMPORTANT: Tailor your questions specifically to this candidate's background, past roles, and skills. Reference their specific experience where relevant.`
    : "";

  const raw = await callClaude(
    apiKey,
    [{
      role: "user",
      content:
        `Generate exactly ${params.numQuestions} interview questions based on this job description.\n` +
        `Question type: ${typeMap[params.questionType] ?? typeMap.mix}\n\n` +
        `Job Description:\n${params.jobContent}` +
        resumeSection + `\n\n` +
        `Return ONLY a JSON object:\n` +
        `{"questions":[{"id":1,"type":"behavioral","question":"Tell me about a time..."}]}\n\n` +
        `Rules: type must be "behavioral" or "technical". Questions must be realistic and relevant. No duplicates.`,
    }],
    "You are an expert technical recruiter and interview coach. Always respond with valid JSON only — no markdown, no extra text.",
  );

  const parsed = parseJSON(raw) as { questions: unknown[] };
  if (!parsed.questions || !Array.isArray(parsed.questions)) {
    throw new Error("Could not parse questions from AI response.");
  }
  return { questions: parsed.questions.slice(0, params.numQuestions) };
}

async function getFeedback(
  apiKey: string,
  params: {
    question: { id: number; type: string; question: string };
    answer: string;
    jobContent: string;
    resumeContent?: string;
  },
) {
  const resumeCtx = params.resumeContent?.trim()
    ? `\nCandidate Background: ${params.resumeContent.slice(0, 1000)}`
    : "";

  const raw = await callClaude(
    apiKey,
    [{
      role: "user",
      content:
        `Evaluate this interview answer:\n\n` +
        `Question: ${params.question.question}\n` +
        `Type: ${params.question.type}\n` +
        `Answer: ${params.answer || "(No answer provided)"}\n\n` +
        `Job Context:\n${params.jobContent.slice(0, 2000)}` +
        resumeCtx + `\n\n` +
        `Return ONLY JSON:\n` +
        `{"questionId":${params.question.id},"score":7,"what_went_well":"...","what_was_missed":"...","how_to_improve":"..."}\n\n` +
        `Scoring: 1-3 poor, 4-6 average, 7-8 good, 9-10 excellent.`,
    }],
    "You are an expert interview coach. Always respond with valid JSON only — no markdown, no extra text.",
  );

  return parseJSON(raw);
}

async function getAllFeedback(
  apiKey: string,
  params: {
    questions: { id: number; type: string; question: string }[];
    answers: { questionId: number; answer: string }[];
    jobContent: string;
    numQuestions: number;
    resumeContent?: string;
  },
) {
  const pairs = params.questions
    .map((q, i) => {
      const a = params.answers.find((a) => a.questionId === q.id);
      return `Q${i + 1} (${q.type}): ${q.question}\nAnswer: ${a?.answer ?? "(No answer)"}`;
    })
    .join("\n\n---\n\n");

  const resumeCtx = params.resumeContent?.trim()
    ? `\nCandidate Background: ${params.resumeContent.slice(0, 1000)}\n`
    : "";

  const raw = await callClaude(
    apiKey,
    [{
      role: "user",
      content:
        `Evaluate all ${params.numQuestions} interview answers.\n\n` +
        `Job Context:\n${params.jobContent.slice(0, 2000)}\n` +
        resumeCtx + `\n` +
        `Q&A:\n${pairs}\n\n` +
        `Return ONLY JSON:\n` +
        `{"overall_summary":"...","feedbacks":[{"questionId":1,"score":7,"what_went_well":"...","what_was_missed":"...","how_to_improve":"..."}]}\n\n` +
        `One feedback per question in order. Scoring: 1-3 poor, 4-6 avg, 7-8 good, 9-10 excellent.`,
    }],
    "You are an expert interview coach. Always respond with valid JSON only — no markdown, no extra text.",
    8192,
  );

  return parseJSON(raw);
}

async function getSummary(
  apiKey: string,
  params: { avg: number; numQuestions: number; jobContent: string },
) {
  const text = await callClaude(
    apiKey,
    [{
      role: "user",
      content:
        `Write a 3-4 sentence performance summary for a candidate who scored ${params.avg.toFixed(1)}/10 ` +
        `average across ${params.numQuestions} interview questions. ` +
        `Mention key strengths and areas to improve. ` +
        `Job context: ${params.jobContent.slice(0, 500)}`,
    }],
    "You are an expert interview coach. Be concise and specific.",
    512,
  );
  return { summary: text.trim() };
}

async function getSampleAnswer(
  apiKey: string,
  params: {
    question: { id: number; type: string; question: string };
    jobContent: string;
    resumeContent?: string;
  },
) {
  const isBehavioral = params.question.type === "behavioral";
  const resumeCtx = params.resumeContent?.trim()
    ? `\nCandidate background: ${params.resumeContent.slice(0, 800)}`
    : "";

  const raw = await callClaude(
    apiKey,
    [{
      role: "user",
      content:
        `Write a strong example answer (score: 9/10) for this interview question.\n\n` +
        `Question: ${params.question.question}\n` +
        `Type: ${params.question.type}\n` +
        `Job Context: ${params.jobContent.slice(0, 800)}` +
        resumeCtx + `\n\n` +
        (isBehavioral
          ? `Use the STAR method clearly. Be specific with realistic situational details, concrete metrics, and outcomes. Avoid vague phrases. 200-280 words.\n\n`
          : `Be specific and demonstrate technical depth. Explain your reasoning and trade-offs clearly. 200-280 words.\n\n`) +
        `Return ONLY JSON: {"sample_answer": "..."}`,
    }],
    "You are an expert interview coach. Always respond with valid JSON only — no markdown, no extra text.",
    1024,
  );
  return parseJSON(raw);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is not set.");
    }

    const body = await req.json();
    const { action, ...params } = body;

    let result: unknown;

    switch (action) {
      case "generate_questions":
        result = await generateQuestions(apiKey, params as Parameters<typeof generateQuestions>[1]);
        break;
      case "get_feedback":
        result = await getFeedback(apiKey, params as Parameters<typeof getFeedback>[1]);
        break;
      case "get_all_feedback":
        result = await getAllFeedback(apiKey, params as Parameters<typeof getAllFeedback>[1]);
        break;
      case "get_summary":
        result = await getSummary(apiKey, params as Parameters<typeof getSummary>[1]);
        break;
      case "get_sample_answer":
        result = await getSampleAnswer(apiKey, params as Parameters<typeof getSampleAnswer>[1]);
        break;
      default:
        throw new Error(`Unknown action: "${action}"`);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
