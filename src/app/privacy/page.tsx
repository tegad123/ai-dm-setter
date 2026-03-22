export default function PrivacyPolicy() {
  return (
    <div className='mx-auto max-w-3xl px-6 py-12'>
      <h1 className='mb-6 text-3xl font-bold'>Privacy Policy</h1>
      <p className='text-muted-foreground mb-8 text-sm'>
        Last updated: March 21, 2026
      </p>

      <div className='space-y-6 text-sm leading-relaxed'>
        <section>
          <h2 className='mb-2 text-xl font-semibold'>
            1. Information We Collect
          </h2>
          <p>
            DMsetter collects information you provide when connecting your
            Facebook Page and Instagram Business account, including page access
            tokens, page names, and Instagram usernames. We also process
            messages received through Facebook Messenger and Instagram Direct
            Messages on your behalf to provide AI-powered reply suggestions.
          </p>
        </section>

        <section>
          <h2 className='mb-2 text-xl font-semibold'>
            2. How We Use Your Information
          </h2>
          <p>We use the collected information to:</p>
          <ul className='mt-2 list-disc space-y-1 pl-6'>
            <li>
              Connect to your Facebook Page and Instagram Business account
            </li>
            <li>Receive and display incoming direct messages</li>
            <li>Generate AI-powered reply suggestions</li>
            <li>Send replies on your behalf when approved</li>
            <li>Track lead quality and conversation analytics</li>
          </ul>
        </section>

        <section>
          <h2 className='mb-2 text-xl font-semibold'>
            3. Data Storage & Security
          </h2>
          <p>
            Access tokens are encrypted using AES-256-GCM before storage. All
            data is stored in secure, encrypted databases. We do not sell or
            share your data with third parties.
          </p>
        </section>

        <section>
          <h2 className='mb-2 text-xl font-semibold'>
            4. Third-Party Services
          </h2>
          <p>
            We integrate with Meta (Facebook/Instagram) APIs to access messaging
            features and Anthropic&apos;s Claude API for AI-generated responses.
            Each service has its own privacy policy governing their data
            handling practices.
          </p>
        </section>

        <section>
          <h2 className='mb-2 text-xl font-semibold'>5. Data Deletion</h2>
          <p>
            You can disconnect your accounts at any time from the Settings page,
            which revokes access tokens and removes stored credentials. To
            request complete data deletion, contact us at support@scalevault.ai.
          </p>
        </section>

        <section>
          <h2 className='mb-2 text-xl font-semibold'>6. Your Rights</h2>
          <p>
            You have the right to access, correct, or delete your personal data
            at any time. You may also revoke our access to your Facebook or
            Instagram accounts through your Meta account settings.
          </p>
        </section>

        <section>
          <h2 className='mb-2 text-xl font-semibold'>7. Contact</h2>
          <p>
            For questions about this privacy policy, contact us at
            support@scalevault.ai.
          </p>
        </section>
      </div>
    </div>
  );
}
