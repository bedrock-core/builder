/** @jsxImportSource @bedrock-core/ui */
import {
  Card,
  Checkbox,
  Divider,
  Radio,
  theme,
  Toggle,
} from '@bedrock-core/ui/ore-styled';
import { Fragment, type JSX, Panel, Screen, Text, useState } from '@bedrock-core/ui';
import { Link, createStackNavigator, createStaticNavigation } from '@bedrock-core/navigation';
import { i18n } from '../i18n';
import { project } from '@bedrock-core/generated/project';
import planPage from './plan';

const { fontColor, spacing } = theme.tokens;

const button = theme.components.button.variants.primary.textures;

function HomePage(): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [plan, setPlan] = useState('basic');

  return (
    <Panel width={300} flexDirection={'column'} padding={spacing.md} gap={spacing.md}>
      {/* A key() string as a child is auto-detected and resolved CLIENT-side. */}
      <Text>{i18n.key($ => $.pack.name)}</Text>
      <Text>{i18n.key($ => $.pack.description)}</Text>

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

      <Link
        screen={'Plan'}
        testId={'starter-plan'}
        width={240}
        height={28}
        background={button.default}
        backgroundHover={button.hover}
        backgroundLocked={button.disabled}
        justifyContent={'center'}
        alignItems={'center'}
      >
        <Text>{`${fontColor.default}See your plan ->`}</Text>
      </Link>

      <Link screen={'Profile'} width={240} height={28} justifyContent={'center'} alignItems={'center'}>
        <Text>{`${fontColor.default}Open Profile Form ->`}</Text>
      </Link>
    </Panel>
  );
}

const RootStack = createStackNavigator({
  id: 'starter',
  initialRouteName: 'Home',
  screenOptions: { headerShown: false },
  screens: {
    Home: HomePage,
    Plan: planPage,
    Profile: `${project.namespace}:profile_form`,
  },
});
type RootStackType = typeof RootStack;
declare module '@bedrock-core/navigation' {
  interface RootNavigator extends RootStackType {}
}
const Navigation = createStaticNavigation(RootStack);

/** Home and Plan share local navigation; Profile opens its separately compiled native form. */
export default function Home(): JSX.Element {
  return <Screen><Panel width={300} height={340}><Navigation /></Panel></Screen>;
}
