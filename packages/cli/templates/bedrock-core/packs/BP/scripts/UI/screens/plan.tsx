/** @jsxImportSource @bedrock-core/ui */
import { Card, Divider, theme } from '@bedrock-core/ui/ore-styled';
import { type JSX, Panel, Text } from '@bedrock-core/ui';
import { Link, CommonActions } from '@bedrock-core/navigation';

const { fontColor, spacing } = theme.tokens;
const button = theme.components.button.variants.secondary.textures;

export default function Plan(): JSX.Element {
  return (
    <Panel width={300} flexDirection={'column'} padding={spacing.md} gap={spacing.md}>
      <Text>{'§lYour plan'}</Text>

      <Card>
        <Text>{`${fontColor.muted}Add the selected plan details here.`}</Text>
        <Divider />
        <Text>{`${fontColor.disabled}What the plan includes goes here.`}</Text>
      </Card>

      <Link
        action={CommonActions.goBack()}
        testId={'starter-back'}
        width={240}
        height={28}
        background={button.default}
        backgroundHover={button.hover}
        backgroundLocked={button.disabled}
        justifyContent={'center'}
        alignItems={'center'}
      >
        <Text>{`${fontColor.default}<- Go Back`}</Text>
      </Link>
    </Panel>
  );
}
