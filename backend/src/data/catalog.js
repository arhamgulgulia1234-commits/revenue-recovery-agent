/** Static pools the generator draws from. Indian market flavour, INR amounts. */

export const FIRST_NAMES = [
  'Aarav','Diya','Rohan','Ananya','Vikram','Meera','Karthik','Priya','Siddharth','Nandini',
  'Arjun','Kavya','Rahul','Sneha','Aditya','Ishita','Manish','Pooja','Varun','Ritika',
  'Nikhil','Shreya','Imran','Fatima','Joseph','Anita','Tanvi','Yash','Deepak','Lakshmi',
  'Sameer','Neha','Gaurav','Divya','Harsh','Preeti','Abhishek','Swati','Rajat','Aisha',
];

export const LAST_NAMES = [
  'Sharma','Iyer','Patel','Reddy','Nair','Mehta','Banerjee','Gupta','Kulkarni','Verma',
  'Singh','Menon','Chopra','Desai','Rao','Joshi','Khan','Fernandes','Ghosh','Bhat',
];

export const COMPANY_PREFIX = [
  'Nimbus','Corevia','Lattice','Bluepeak','Ardent','Quanta','Zephyr','Northgate','Vertex','Sable',
  'Kestrel','Meridian','Foundry','Halcyon','Brightline','Cobalt','Ironwood','Solstice',
];

export const COMPANY_SUFFIX = [
  'Logistics','Technologies','Retail','Healthcare','Analytics','Manufacturing','Media',
  'Financial Services','Infrastructure','Labs',
];

export const COMPANY_TYPE = ['Pvt Ltd', 'LLP', 'Industries'];

/** Plans by segment: [name, minAmount, maxAmount, frequency weights]. */
export const PLANS = {
  consumer: [
    { name: 'Streaming — Basic', min: 149, max: 199 },
    { name: 'Streaming — Premium', min: 299, max: 499 },
    { name: 'Fitness App — Monthly', min: 399, max: 799 },
    { name: 'Music Unlimited', min: 119, max: 179 },
    { name: 'Cloud Storage 200GB', min: 129, max: 249 },
  ],
  prosumer: [
    { name: 'Creator Pro', min: 999, max: 1499 },
    { name: 'Design Suite — Individual', min: 1299, max: 2299 },
    { name: 'Trading Terminal Plus', min: 1499, max: 2999 },
    { name: 'Learning Pro — Annual', min: 1999, max: 2999 },
  ],
  smb: [
    { name: 'Billing Software — Growth', min: 2999, max: 6999 },
    { name: 'POS Suite — 5 Terminals', min: 4999, max: 11999 },
    { name: 'HR & Payroll — 50 seats', min: 7999, max: 18999 },
    { name: 'Logistics Tracker — Business', min: 3499, max: 9999 },
    { name: 'CRM — Team', min: 5999, max: 24999 },
  ],
};

/** B2B invoice line-item descriptions, used for message copy context. */
export const INVOICE_ITEMS = [
  'Q3 platform licence',
  'Managed services retainer',
  'Implementation milestone 2',
  'Annual support & maintenance',
  'Transaction processing fees',
  'Warehouse integration build',
  'Data migration services',
];

export const AP_CONTACT_TITLES = ['Accounts Payable', 'Finance Team', 'Controller', 'AP Desk'];
