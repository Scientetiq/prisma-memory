import { DEMO_UNIT, DEMO_SPACE, DEMO_PEOPLE, DEMO_ROLE_TITLES, DEMO_SAMPLES } from "../messages/demo";

export { DEMO_UNIT } from "../messages/demo";
export { DEMO_SPACE } from "../messages/demo";
export { DEMO_PEOPLE } from "../messages/demo";
export type DemoRole = keyof typeof DEMO_PEOPLE;
export { DEMO_ROLE_TITLES } from "../messages/demo";

export function demoPeopleBody() {
  return {
    people: [
      { login: DEMO_PEOPLE.head.login, display_name: DEMO_PEOPLE.head.display_name, department: DEMO_UNIT.name, role: DEMO_PEOPLE.head.role, active: true,
        attrs: { demo: true, demo_role: "head", department_code: DEMO_UNIT.code, unit_relation: "head" } },
      { login: DEMO_PEOPLE.employee.login, display_name: DEMO_PEOPLE.employee.display_name, department: DEMO_UNIT.name, role: DEMO_PEOPLE.employee.role, active: true,
        manager_login: DEMO_PEOPLE.head.login, attrs: { demo: true, demo_role: "employee", department_code: DEMO_UNIT.code } },
    ],
  };
}

export interface DemoSample { who: DemoRole; kind: "remember" | "upload"; space: "me" | "showcase"; title: string; text: string; eventKind?: "note" | "decision" | "action" | "question_risk" | "fact"; filename?: string }

export { DEMO_SAMPLES } from "../messages/demo";
