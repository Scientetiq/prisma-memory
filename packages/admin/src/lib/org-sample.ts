export const ORG_TABLE_SAMPLE = `login;display_name;employee_id;department;department_code;parent_department_code;manager_login;role;unit_relation
ceo@corp.test;Jane Miller;10001;Executive Office;EXEC;;;Chief Executive Officer;head
eng.head@corp.test;Robert Hayes;10002;Engineering;ENG;EXEC;ceo@corp.test;Head of Engineering;head
eng.deputy@corp.test;Emily Carter;10003;Engineering;ENG;EXEC;eng.head@corp.test;Deputy Head of Engineering;deputy
eng.dev@corp.test;Michael Brooks;10004;Engineering;ENG;EXEC;eng.head@corp.test;Software Engineer;
eng.analyst@corp.test;Sarah Collins;10005;Engineering;ENG;EXEC;eng.head@corp.test;Data Analyst;
eng.pm@corp.test;David Turner;10006;Engineering;ENG;EXEC;eng.deputy@corp.test;Project Manager;
`;

export const ORG_TABLE_SAMPLE_NAME = "org-table-sample.csv";

export const orgTableSampleHref = (): string => `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${ORG_TABLE_SAMPLE}`)}`;
