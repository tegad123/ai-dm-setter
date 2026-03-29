"""
Notification Service — Sends alerts to Daniel and team on key events.
Supports:
  - Email notifications (SMTP)
  - In-app notifications (stored in DB, delivered via WebSocket on Day 3)
  - Push notifications (wired up on Day 4 with mobile)

Triggered on:
  - Call booked (instant alert)
  - Daily summary report (Day 4)
  - Weekly performance report (Day 4)
"""
import logging
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from app.core.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


async def notify_team(
    event: str,
    lead_name: str,
    lead_id: str,
    details: str = "",
) -> bool:
    """
    Send notification to Daniel and team about a key event.
    Returns True if notification was sent successfully.
    """
    subject, body = _build_notification(event, lead_name, lead_id, details)

    # Email notification
    email_sent = await _send_email(subject, body)

    # Log for in-app notification (WebSocket delivery wired in Day 3)
    logger.info(f"NOTIFICATION [{event}]: {subject} — {lead_name} (lead {lead_id})")

    return email_sent


async def _send_email(subject: str, body: str) -> bool:
    """Send email notification via SMTP."""
    if not settings.notification_email or not settings.smtp_host:
        logger.warning("Email notification skipped — SMTP not configured")
        return False

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = settings.smtp_user or "noreply@daetradez.com"
        msg["To"] = settings.notification_email

        # Plain text body
        msg.attach(MIMEText(body, "plain"))

        # HTML body
        html_body = f"""
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #1a1a2e; color: white; padding: 20px; text-align: center;">
                <h1 style="margin: 0; font-size: 24px;">DAETRADEZ AI DM Setter</h1>
            </div>
            <div style="padding: 24px; background: #f8f9fa;">
                {body.replace(chr(10), '<br>')}
            </div>
            <div style="padding: 12px; text-align: center; color: #666; font-size: 12px;">
                Automated notification from your AI DM Setter
            </div>
        </div>
        """
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as server:
            server.starttls()
            if settings.smtp_user and settings.smtp_password:
                server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(msg)

        logger.info(f"Email sent: {subject}")
        return True

    except Exception as e:
        logger.error(f"Failed to send email notification: {e}")
        return False


def _build_notification(event: str, lead_name: str, lead_id: str, details: str) -> tuple[str, str]:
    """Build notification subject and body based on event type."""
    if event == "call_booked":
        subject = f"🔥 New Call Booked — {lead_name}"
        body = (
            f"A new call has been booked!\n\n"
            f"Lead: {lead_name}\n"
            f"{details}\n\n"
            f"The AI qualified this lead through DM conversation and booked the call automatically.\n"
            f"View full conversation in the dashboard."
        )
    elif event == "hot_lead":
        subject = f"🔥 Hot Lead Alert — {lead_name}"
        body = (
            f"A lead is showing high intent!\n\n"
            f"Lead: {lead_name}\n"
            f"{details}\n\n"
            f"This lead is highly engaged and close to booking."
        )
    elif event == "human_override_needed":
        subject = f"⚠️ Human Override Needed — {lead_name}"
        body = (
            f"The AI has flagged a conversation that may need human attention.\n\n"
            f"Lead: {lead_name}\n"
            f"{details}\n\n"
            f"Please review this conversation in the dashboard."
        )
    else:
        subject = f"DAETRADEZ Notification — {event}"
        body = f"Event: {event}\nLead: {lead_name}\n{details}"

    return subject, body
