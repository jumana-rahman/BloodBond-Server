# BloodBond

BloodBond is a full-stack blood donation management platform that connects blood donors with recipients. The platform allows users to register as donors, request blood donations, manage donation requests, and enables administrators and volunteers to efficiently manage the system.

## Purpose

The purpose of BloodBond is to make the blood donation process easier, faster, and more organized by providing a centralized platform where:

- Donors can register and manage their profiles.
- Recipients can create blood donation requests.
- Volunteers can help manage donation requests.
- Administrators can control users, content, and overall system activities.

---

## Live Website

**Live URL:** https://bloodbondfrontend.vercel.app

---

## Client Repository

https://github.com/jumana-rahman/BloodBond-Client

---

## Server Repository

https://github.com/jumana-rahman/BloodBond-Server

---

## Key Features

- Secure authentication using Better Auth
- Role-based authorization (Admin, Donor, Volunteer)
- User registration with district and upazila selection
- JWT-based protected routes
- Responsive design for desktop, tablet, and mobile
- Blood donation request management
- Donor profile management
- Dashboard for each user role
- Create, edit, and delete donation requests
- Search donors by blood group, district, and upazila
- Donation request status tracking
- Content management for blogs
- Image upload using ImgBB
- Loading states and protected pages
- 401, 403, and 404 custom pages

---

## Tech Stack

### Frontend

- Next.js
- React
- Tailwind CSS
- HeroUI

### Backend

- Node.js
- Express.js
- MongoDB
- Better Auth
- JWT

---

## NPM Packages Used

### Frontend

- next
- react
- react-dom
- tailwindcss
- heroui
- better-auth
- react-hot-toast
- react-icons
- framer-motion

### Authentication

- better-auth

### Backend

- express
- mongodb
- cors
- dotenv
- jsonwebtoken
- cookie-parser
- bcryptjs

### BloodBond Specific

- bd-upazilas
- bd-districts

---

## Environment Variables

### Client

```env
BETTER_AUTH_SECRET=
NEXT_PUBLIC_API_URL=
NEXT_PUBLIC_IMAGEBB_KEY=
NEXT_PUBLIC_BETTER_AUTH_URL=
```

### Server

```env
PORT=
MONGODB_URI=
JWT_SECRET=
CLIENT_URL=
```

---

## Installation

### Clone Client

```bash
git clone https://github.com/jumana-rahman/BloodBond-Client.git
```

```bash
cd BloodBond-Client
```

```bash
npm install
```

```bash
npm run dev
```

---

### Clone Server

```bash
git clone https://github.com/jumana-rahman/BloodBond-Server.git
```

```bash
cd BloodBond-Server
```

```bash
npm install
```

```bash
npm run dev
```

---

## Future Improvements

- Email verification
- Password reset
- Real-time notifications
- Blood request approval workflow
- Donation history analytics
- SMS notification integration
- Dark mode
- PWA support

---

## Author

**Jumana Bint Rahman**

