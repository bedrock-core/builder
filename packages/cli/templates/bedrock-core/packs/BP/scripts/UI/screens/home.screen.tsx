/** @jsxImportSource @bedrock-core/ui */
import {
  Button,
  Card,
  Checkbox,
  Divider,
  Radio,
  theme,
  Toggle,
} from '@bedrock-core/ui/ore-styled';
import { Fragment, type JSX, Panel, Screen, Text, useState } from '@bedrock-core/ui';
import { i18n } from '../i18n';
import { project } from '@bedrock-core/generated/project';

const { fontColor, spacing } = theme.tokens;

/**
 * The addon's home screen, opened by `render()` in main.ts on a button push.
 * The compiled key combines the shared project namespace with `home`.
 */
export default function Home(): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [plan, setPlan] = useState('basic');

  return (
    <Screen>
      <Panel flexDirection={'column'} padding={spacing.md} gap={spacing.md}>
        {/* A key() string as a child is auto-detected and resolved CLIENT-side. */}
        <Text>{i18n.key($ => $.meta.name)}</Text>
        <Text>{i18n.key($ => $.meta.description)}</Text>

        <Card>
          <Text>{'Preferences'}</Text>
          <Divider />
          <Panel flexDirection={'row'} alignItems={'center'} gap={spacing.md}>
            <Fragment>
              <Toggle on={enabled} onChange={setEnabled} />
              {/* State-driven text needs maxLength to reserve room for its longest value. */}
              <Text maxLength={20}>{`Auto-save: ${enabled ? '§aON' : '§cOFF'}`}</Text>
            </Fragment>
          </Panel>
          <Checkbox label={'I agree to the terms'} on={accepted} onChange={setAccepted} />
        </Card>

        <Card>
          <Text>{'Choose a plan'}</Text>
          <Divider />
          <Radio
            value={plan}
            onChange={setPlan}
            options={[
              { value: 'basic', label: 'Basic' },
              { value: 'pro', label: 'Pro' },
              { value: 'team', label: 'Team' },
            ]}
          />
        </Card>

        {/* A static target compiles to a plain link with no handler. */}
        <Button to={`${project.namespace}:plan`}>
          {`${fontColor.default}See your plan ->`}
        </Button>

        {/* No live value to carry: `to` makes this a plain compiled link, no handler needed. */}
        <Button variant={'secondary'} to={`${project.namespace}:profile_form`}>
          {`${fontColor.default}Open Profile Form ->`}
        </Button>
      </Panel>
    </Screen>
  );
}
