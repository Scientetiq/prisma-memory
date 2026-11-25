import type { DemoSample } from "../../lib/demo";
// Messages in the language of the current request. One export per dictionary.
export const DEMO_UNIT = { code: "demo", name: "Demo department" };

export const DEMO_SPACE = { slug: "demo-showcase", name: "Memory showcase (demo)", description: "Training space for the role showcase: fictional demo department materials. Open records let preview display the sample." };

export const DEMO_PEOPLE = { head: { login: "demo.head@corp.test", display_name: "Demo manager", role: "demo department manager" }, employee: { login: "demo.employee@corp.test", display_name: "Demo colleague", role: "demo department specialist" } };

export const DEMO_ROLE_TITLES = { head: "Manager", employee: "Colleague" };

export const DEMO_SAMPLES: DemoSample[] = [
  {
    "who": "head",
    "kind": "upload",
    "space": "showcase",
    "title": "Demo department policy: approving commercial proposals",
    "filename": "reglament-demo-kp.md",
    "text": "---\ntitle: Proposal approval policy (demo)\nversion: 1.0\n---\n<!-- page: 1 -->\n# Commercial proposal approval policy (demo)\n\n## 1. Scope\n\nThis policy describes how the demo department prepares and approves commercial proposals. This is a training document with fictional data.\n\n## 2. Deadlines\n\n| Stage | Deadline | Responsible role |\n|---|---|---|\n| Prepare the estimate | 2 working days | specialist |\n| Check the margin | 1 working day | manager |\n| Send to the customer | on the day of approval | specialist |\n\n<!-- page: 2 -->\n## 3. Margin threshold\n\nThe department manager approves proposals with discounts above 10 %; the margin threshold is 18 %.\n\n## 4. Storage\n\nApproved proposals are uploaded to the department’s memory on the day they are sent.\n"
  },
  {
    "who": "head",
    "kind": "remember",
    "space": "showcase",
    "eventKind": "decision",
    "title": "Decision: weekly status updates for the Showcase project",
    "text": "We decided to hold weekly status updates for the Showcase project on Mondays at 11:00. Reason: two deadline changes in September. Daily short calls were considered and rejected as excessive."
  },
  {
    "who": "head",
    "kind": "remember",
    "space": "me",
    "eventKind": "note",
    "title": "Questions for the meeting with the Demo Stand supplier",
    "text": "Clarify beam delivery dates, deferred payment terms and batch certificate availability. Ask for an updated price list by the end of the week."
  },
  {
    "who": "employee",
    "kind": "upload",
    "space": "showcase",
    "title": "Test delivery report (demo)",
    "filename": "otchet-testovaya-postavka.md",
    "text": "# Test delivery report (demo)\n\n<!-- page: 1 -->\n## Results\n\nThe customer Alpha Test accepted a test batch of 12 shelving units without issues. Installation took 3 days instead of the planned 4.\n\n## Deviations\n\n- Delivery was delayed by 1 day due to the supplier’s warehouse workload.\n- One set of fasteners was replaced on site.\n\n<!-- page: 2 -->\n## Suggestions\n\n1. Allow 1 extra day for delivery in future proposals.\n2. Check fastener completeness at dispatch.\n"
  },
  {
    "who": "employee",
    "kind": "remember",
    "space": "showcase",
    "eventKind": "action",
    "title": "Task: compare two shelving options",
    "text": "Prepare a comparison of two shelving options for Omega Retail by Friday: price, delivery time and shelf load capacity. Responsible role: demo department specialist."
  },
  {
    "who": "employee",
    "kind": "remember",
    "space": "me",
    "eventKind": "fact",
    "title": "Fact: demo customer warehouse hours",
    "text": "The demo customer’s warehouse accepts deliveries from 8:00 to 20:00 on weekdays; Saturday deliveries require an advance request."
  },
  {
    "who": "employee",
    "kind": "remember",
    "space": "me",
    "eventKind": "decision",
    "title": "Decision: allow extra delivery time in proposal estimates",
    "text": "We decided to allow 1 extra day for delivery in the demo department’s commercial proposal estimates, based on the test delivery report."
  },
  {
    "who": "employee",
    "kind": "remember",
    "space": "me",
    "eventKind": "question_risk",
    "title": "Risk: a single fastener supplier",
    "text": "Fasteners come from a single supplier: a delay would stop installation. A second supplier is needed by next quarter."
  }
];
