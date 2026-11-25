import { rich } from "@/i18n/rich";

import { newProjectPage as M } from "@/messages/ws-projects";
import type { Metadata } from "next";
import { Icon } from "@/components/icons";
import { PeoplePicker } from "@/components/people-picker";
import { SlugPreview } from "@/components/project-slug";
import { Field, Notice, PageHead } from "@/components/ui";
import { CLOSED_CLASS_TEXT } from "@/lib/closed-class";
import { CLASS_CHOICE, SPACE_README } from "@/lib/plain";
import { PROJECT_DESCRIPTION_MAX, PROJECT_MEMBERS_MAX, PROJECT_NAME_MAX, PROJECT_README_MAX } from "@/lib/form";
import { requireWorkspace } from "@/lib/me";
import { meGw } from "@/lib/me-api";
import { PREVIEW_TEXT } from "@/lib/preview";
import { readmeTemplateOf } from "@/lib/space-readme";
import type { SpaceReadmeConfig } from "@/lib/types";
import { BackLink } from "../../browse/space-parts";
import { createProjectAction } from "../actions";
import { NewProjectForm } from "./new-project-form";

export function generateMetadata(): Metadata { return { title: M.metadataTitle }; }

export default async function NewProjectPage() {
  const { session, me } = await requireWorkspace();
  let template: string | null = null;
  if (!session.preview) { try { template = readmeTemplateOf(await meGw<SpaceReadmeConfig>(session.key, "/api/v1/me/space-readme")); } catch { template = null; } }
  return (
    <>
      <BackLink href="/browse">{M.spacesAndProjects5}</BackLink>
      <PageHead title={M.newProject2} lead={M.sharedMemoryForAProjectTeamYou} />
      {session.preview ? <Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice> : (
        <NewProjectForm action={createProjectAction}>
          <ol className="np-steps">
            <li className="np-step">
              <span className="ichip tone-violet"><Icon name="pencil" /></span>
              <div className="np-body">
                <h2>{M.whatShallWeCallTheProject}</h2>
                <Field label={M.name2} hint={M.aCodeNameWithoutCustomerNamesCovered}>
                  <input type="text" name="name" maxLength={PROJECT_NAME_MAX} placeholder={M.forExampleCrmMigration} required />
                </Field>
                <SlugPreview />
                <Field label={M.whatToSaveHere2} hint={M.optionalMembersAiAgentsCanSeeThis}>
                  <textarea name="description" rows={3} maxLength={PROJECT_DESCRIPTION_MAX} placeholder={M.crmMigrationDecisionsAndAgreementsDeadlinesScope} />
                </Field>
                {template !== null ? (
                  <Field label={SPACE_README.label} hint={SPACE_README.newHint}>
                    <textarea name="readme" rows={12} maxLength={PROJECT_README_MAX} defaultValue={template} className="readme-text" />
                  </Field>
                ) : null}
              </div>
            </li>

            <li className="np-step">
              <span className="ichip tone-blue"><Icon name="eye" /></span>
              <fieldset className="np-body">
                <legend><h2>{M.whoCanSeeNewRecords2}</h2></legend>
                <div className="np-choices">
                  <label className="np-choice">
                    <input type="radio" name="default_class" value="open" defaultChecked />
                    <span className="ichip sm tone-green"><Icon name="bot" /></span>
                    <span className="np-choice-text"><b>{CLASS_CHOICE.open.title}</b><small>{CLASS_CHOICE.open.hint}</small></span>
                  </label>
                  <label className="np-choice">
                    <input type="radio" name="default_class" value="closed" />
                    <span className="ichip sm tone-gray"><Icon name="lock" /></span>
                    <span className="np-choice-text"><b>{CLASS_CHOICE.closed.title}</b><small>{CLASS_CHOICE.closed.hint}</small></span>
                  </label>
                </div>
                <div className="np-open-only">
                  <p className="np-warn">{rich(M.aiAgentsUsingExternalCloudModelsLine, { tag1: () => <Icon name="alert" />, tag2: (children) => <span>{children}</span> })}</p>
                  <details className="sp-more-info"><summary>{M.moreDetails}</summary><p>{CLOSED_CLASS_TEXT.openSpaceWarning}</p></details>
                  <label className="check np-ack"><input type="checkbox" name="open_ack" aria-describedby="np-ack-req" /> {M.iUnderstandMembersAiAgentsCanRead2}<span className="req" id="np-ack-req">{M.required}</span></label>
                </div>
              </fieldset>
            </li>

            <li className="np-step">
              <span className="ichip tone-brand"><Icon name="user-plus" /></span>
              <div className="np-body">
                <h2>{M.whoToInvite}</h2>
                <PeoplePicker name="members" max={PROJECT_MEMBERS_MAX} self={me.person.login} allowWaiting />
                <noscript>
                  <style>{".pp{display:none}"}</style>
                  <Field label={M.colleagues} hint={M.optionalUpToEmailAddressesSeparatedBy(PROJECT_MEMBERS_MAX)}>
                    <textarea name="members" rows={2} placeholder={M.inviteEmailsExample} autoCapitalize="none" spellCheck={false} />
                  </Field>
                </noscript>
              </div>
            </li>
          </ol>

          <details className="sp-more-info np-extra">
            <summary>{M.advanced}</summary>
            <Field label={M.spaceAddress} hint={M.useLatinLettersDigitsAndHyphensLeave}>
              <input type="text" name="slug" pattern="[a-z0-9][a-z0-9\-]{1,62}" autoCapitalize="none" spellCheck={false} />
            </Field>
          </details>
        </NewProjectForm>
      )}
    </>
  );
}
