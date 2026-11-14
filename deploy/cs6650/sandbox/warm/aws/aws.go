// Package warmaws is never run: the cloud SDK packages a homework imports (config, credentials), compiled into the image build cache by the Dockerfile (docs/GO_SANDBOX.md).
package warmaws

import (
	_ "github.com/aws/aws-sdk-go-v2/aws"
	_ "github.com/aws/aws-sdk-go-v2/config"
	_ "github.com/aws/aws-sdk-go-v2/credentials"
)
