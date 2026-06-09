#!/bin/bash
# Run after Kafka is healthy: bash scripts/create-kafka-topics.sh

BROKER=${KAFKA_BROKERS:-localhost:9092}
PARTITIONS=12
REPLICATION=1

TOPICS=(
  # Auth
  kmkt.auth.user-registered
  kmkt.auth.user-verified
  kmkt.auth.session-created

  # Market
  kmkt.market.created
  kmkt.market.activated
  kmkt.market.closed
  kmkt.market.resolved
  kmkt.market.cancelled
  kmkt.market.price-updated

  # Trading
  kmkt.trading.trade-initiated
  kmkt.trading.trade-confirmed
  kmkt.trading.trade-failed
  kmkt.trading.position-updated
  kmkt.trading.market-settled

  # Wallet
  kmkt.wallet.credited
  kmkt.wallet.debited
  kmkt.wallet.reserve-created
  kmkt.wallet.reserve-released

  # Payment
  kmkt.payment.deposit-initiated
  kmkt.payment.deposit-completed
  kmkt.payment.deposit-failed
  kmkt.payment.withdrawal-initiated
  kmkt.payment.withdrawal-completed
  kmkt.payment.withdrawal-failed
  kmkt.payment.callback-received

  # Notifications
  kmkt.notification.send-sms
  kmkt.notification.send-push
  kmkt.notification.send-email

  # Analytics
  kmkt.analytics.trade-event
  kmkt.analytics.payment-event
  kmkt.analytics.market-event
)

echo "Creating Kafka topics on broker: $BROKER"

for topic in "${TOPICS[@]}"; do
  kafka-topics --bootstrap-server "$BROKER" \
    --create \
    --if-not-exists \
    --topic "$topic" \
    --partitions "$PARTITIONS" \
    --replication-factor "$REPLICATION"
  echo "  Created: $topic"
done

echo "Done. Topics created: ${#TOPICS[@]}"
