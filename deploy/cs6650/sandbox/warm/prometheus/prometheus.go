// Package warmprometheus is never run: see ../aws/aws.go.
package warmprometheus

import (
	_ "github.com/prometheus/client_golang/prometheus"
	_ "github.com/prometheus/client_golang/prometheus/promauto"
	_ "github.com/prometheus/client_golang/prometheus/promhttp"
)
