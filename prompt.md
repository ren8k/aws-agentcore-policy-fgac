<instruction>
ありがとう。続いて、以下を修正してほしい。

- `/Users/renkuji/Workspace/aws-agentcore-policy/cdk-agentcore-policy/lambda/pre_token/index.py`

修正内容としては、以下と同一にすること。

- `/Users/renkuji/Workspace/aws-agentcore-policy/cdk-agentcore-policy/lambda/pre_token/index.py`

上記の修正に伴い、以下も修正が必要になる。

- `/Users/renkuji/Workspace/aws-agentcore-policy/cdk-agentcore-gw-interceptors/lambda/request/index.py`

pre token generation lambda では、role ベースで利用可能なツールを制御するように修正されるためである。（修正前は、scope ベースでツールの FGAC を実現している。）

上記を実行しなさい。
</instruction>
