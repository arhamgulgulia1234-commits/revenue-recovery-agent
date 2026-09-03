export type TimelineEvent = {
  id: string;
  sequence: number;
  event_type: string;
  decision: string;
  reasoning_text: string;
  reasoning_source: 'llm' | 'template';
  policy_refs: string | null;
  created_at: string;
  attemptNumber: number | null;
  intervention: {
    id: string; sequence: number; action_type: string; channel: string;
    tone: string | null; message_sent: string | null;
    scheduled_for: string; executed_at: string | null;
    outcome: string | null; outcome_detail: string | null;
  } | null;
};

export type CaseDetail = {
  case: {
    id: string; customer_name: string; segment: string; status: string;
    root_cause: string; root_cause_confidence: number;
    amount_at_risk_inr: number; recovered_amount_inr: number;
    attempts_used: number; opened_at: string; closed_at: string | null;
    closure_reason: string | null;
    /** When the agent next looks at this case: a response deadline, a scheduled
     *  send, or a promised payment date. Null once the case closes. */
    next_action_at: string | null;
    delivery_mode: 'simulated' | 'live';
    contact_phone: string | null;
    /** Razorpay, on a live case that minted a link. Null everywhere else. */
    payment_link_id: string | null;
    payment_link_url: string | null;
    payment_link_status: string | null;
    payment_id: string | null;
    paid_at: string | null;
    decline_code: string; gateway_message: string; attempt_number: number;
    failed_at: string; plan_name: string | null; invoice_number: string | null;
    opted_out_at: string | null; disputed_at: string | null;
    recovery_score: number; score_band: string; score_explanation: string;
  };
  narrator: { provider: string; model: string };
  timeline: TimelineEvent[];
};
